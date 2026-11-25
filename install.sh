#!/usr/bin/env bash
#
# SayScript — kreator instalacji (Linux + macOS).
#
# Robi wszystko za Ciebie:
#   1. sprawdza PHP (i proponuje jego instalację),
#   2. pobiera Composera lokalnie i instaluje zależności serwera,
#   3. ustawia serwer jako usługę uruchamiającą się sama po zalogowaniu
#      (Linux: systemd --user, macOS: launchd) — NIE wymaga sudo ani roota,
#   4. sprawdza, czy serwer odpowiada, i pokazuje, jak wgrać rozszerzenie do Chrome.
#
# Użycie:
#   ./install.sh                 # pełna instalacja
#   ./install.sh --no-service    # tylko zależności (serwer uruchomisz ręcznie: ./start.sh)
#   ./install.sh --port 8166     # inny port (musisz go też zmienić w rozszerzeniu!)
#   ./install.sh --uninstall     # usuwa usługę (pliki i skrypty zostają)
#   ./install.sh --yes           # nie pytaj o nic (zakłada "tak")
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
SCRIPTS_DIR="$ROOT/scripts"
TOOLS_DIR="$ROOT/tools"
PORT=8165
DO_SERVICE=1
UNINSTALL=0
ASSUME_YES=0
SERVICE_NAME="${SAYSCRIPT_SERVICE_NAME:-sayscript}"   # (zmienna tylko do testów)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)       PORT="$2"; shift 2 ;;
    --no-service) DO_SERVICE=0; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//; 1d'; exit 0 ;;
    *) echo "Nieznana opcja: $1" >&2; exit 1 ;;
  esac
done

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_bld=$'\033[1m'; c_off=$'\033[0m'
step() { echo; echo "${c_bld}${c_grn}[$1]${c_off} ${c_bld}$2${c_off}"; }
ok()   { echo "  ${c_grn}✓${c_off} $*"; }
warn() { echo "  ${c_yel}!${c_off} $*"; }
die()  { echo "  ${c_red}✗ $*${c_off}" >&2; exit 1; }
ask() {  # ask "pytanie" -> 0 gdy tak
  [[ $ASSUME_YES -eq 1 ]] && return 0
  local a; read -r -p "  $1 [T/n] " a || true
  [[ -z "$a" || "$a" =~ ^[TtYy] ]]
}

OS="$(uname -s)"
case "$OS" in
  Linux)  PLATFORM=linux ;;
  Darwin) PLATFORM=mac ;;
  *) die "Ten instalator obsługuje Linux i macOS. Na Windows użyj Install-SayScript.bat." ;;
esac

# ---------------------------------------------------------------- odinstalowanie
if [[ $UNINSTALL -eq 1 ]]; then
  step "-" "Usuwanie usługi SayScript"
  if [[ $PLATFORM == linux ]]; then
    systemctl --user disable --now "$SERVICE_NAME.service" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$SERVICE_NAME.service"
    systemctl --user daemon-reload 2>/dev/null || true
  else
    PLIST="$HOME/Library/LaunchAgents/dev.$SERVICE_NAME.plist"
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
  fi
  ok "Usługa usunięta. Twoje skrypty w $SCRIPTS_DIR zostały nietknięte."
  echo "  Rozszerzenie usuń ręcznie w chrome://extensions."
  exit 0
fi

echo "================================================"
echo "  SayScript — kreator instalacji"
echo "================================================"

# ---------------------------------------------------------------- 1. PHP
step "1/4" "Sprawdzam PHP (potrzebne 8.1 lub nowsze)"
php_ok() { command -v php >/dev/null 2>&1 && php -r 'exit(version_compare(PHP_VERSION,"8.1.0",">=")?0:1);'; }

if ! php_ok; then
  warn "Nie znaleziono PHP 8.1+."
  if ask "Zainstalować PHP teraz? (może zapytać o hasło administratora)"; then
    if   command -v apt-get >/dev/null; then sudo apt-get update && sudo apt-get install -y php-cli php-mbstring php-zip unzip curl
    elif command -v dnf     >/dev/null; then sudo dnf install -y php-cli php-mbstring php-json unzip curl
    elif command -v pacman  >/dev/null; then sudo pacman -S --noconfirm php unzip curl
    elif command -v zypper  >/dev/null; then sudo zypper install -y php8 php8-mbstring unzip curl
    elif command -v brew    >/dev/null; then brew install php
    else die "Nie umiem zainstalować PHP automatycznie. Zainstaluj PHP 8.1+ i uruchom instalator ponownie."
    fi
  fi
  php_ok || die "PHP 8.1+ nadal niedostępne. Zainstaluj je i uruchom ./install.sh ponownie."
fi
PHP_BIN="$(command -v php)"
ok "PHP $(php -r 'echo PHP_VERSION;') ($PHP_BIN)"

# ---------------------------------------------------------------- 2. zależności
step "2/4" "Instaluję zależności serwera (biblioteka WebSocket)"
if [[ ! -f "$SERVER_DIR/vendor/autoload.php" ]]; then
  if command -v composer >/dev/null 2>&1; then
    COMPOSER=(composer)
  else
    mkdir -p "$TOOLS_DIR"
    if [[ ! -f "$TOOLS_DIR/composer.phar" ]]; then
      echo "  Pobieram Composera (menedżer zależności PHP)…"
      curl -fsSL https://getcomposer.org/composer-stable.phar -o "$TOOLS_DIR/composer.phar" \
        || die "Nie udało się pobrać Composera. Sprawdź połączenie z internetem."
    fi
    COMPOSER=("$PHP_BIN" "$TOOLS_DIR/composer.phar")
  fi
  ( cd "$SERVER_DIR" && "${COMPOSER[@]}" install --no-dev --no-interaction --no-progress ) \
    || die "Instalacja zależności nie powiodła się (komunikat powyżej)."
  ok "Zależności zainstalowane."
else
  ok "Zależności już są."
fi
mkdir -p "$SCRIPTS_DIR"
ok "Folder na skrypty: $SCRIPTS_DIR"

# ---------------------------------------------------------------- 3. usługa
SERVER_CMD=("$PHP_BIN" "$SERVER_DIR/server.php" "--port=$PORT" "--dir=$SCRIPTS_DIR" "--interval=1.0")

port_listening() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | grep -q "[:.]$PORT "
  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
  fi
}

if [[ $DO_SERVICE -eq 1 ]]; then
  step "3/4" "Ustawiam automatyczne uruchamianie serwera po zalogowaniu"
  if port_listening; then
    warn "Port $PORT jest już zajęty (np. serwer SayScript uruchomiony ręcznie przez start.sh)."
    warn "Zamknij go (Ctrl+C w jego oknie) — usługa przejmie jego rolę."
  fi
  if [[ $PLATFORM == linux ]]; then
    command -v systemctl >/dev/null || die "Brak systemd. Użyj ./install.sh --no-service i uruchamiaj ./start.sh ręcznie."
    UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/$SERVICE_NAME.service" <<EOF
[Unit]
Description=SayScript local WebSocket server (userscript two-way sync)

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
ExecStart=${SERVER_CMD[*]}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "$SERVICE_NAME.service" >/dev/null 2>&1
    systemctl --user restart "$SERVICE_NAME.service"
    ok "Usługa użytkownika ($SERVICE_NAME) włączona — startuje sama po zalogowaniu."
  else
    PLIST="$HOME/Library/LaunchAgents/dev.$SERVICE_NAME.plist"; mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.$SERVICE_NAME</string>
  <key>ProgramArguments</key><array>
$(for a in "${SERVER_CMD[@]}"; do echo "    <string>$a</string>"; done)
  </array>
  <key>WorkingDirectory</key><string>$SERVER_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    ok "Agent launchd (dev.$SERVICE_NAME) załadowany — startuje sam po zalogowaniu."
  fi
else
  step "3/4" "Pomijam usługę (--no-service) — serwer uruchomisz poleceniem ./start.sh"
fi

# ---------------------------------------------------------------- 4. weryfikacja
step "4/4" "Sprawdzam, czy serwer działa"
if [[ $DO_SERVICE -eq 1 ]]; then
  UP=0; for _ in 1 2 3 4 5 6 7 8 9 10; do port_listening && { UP=1; break; }; sleep 1; done
  if [[ $UP -eq 1 ]]; then ok "Serwer nasłuchuje na ws://localhost:$PORT"
  else
    warn "Serwer nie odpowiada na porcie $PORT."
    [[ $PLATFORM == linux ]] && echo "    Podgląd błędów: journalctl --user -u $SERVICE_NAME -n 30"
  fi
fi

cat <<EOF

${c_bld}${c_grn}Serwer gotowy.${c_off} Został ostatni krok — wgranie rozszerzenia do Chrome (zajmie ~1 minutę):

  1. Otwórz w Chrome (lub Edge/Brave) adres:  ${c_bld}chrome://extensions${c_off}
  2. Włącz ${c_bld}Tryb programisty${c_off} (Developer mode) — przełącznik w prawym górnym rogu.
  3. Kliknij ${c_bld}Załaduj rozpakowane${c_off} (Load unpacked) i wskaż folder:
       ${c_bld}$ROOT/extension${c_off}
  4. Na karcie rozszerzenia SayScript kliknij ${c_bld}Szczegóły${c_off} (Details) i włącz
     ${c_bld}Zezwalaj na skrypty użytkownika${c_off} (Allow user scripts).
  5. Przypnij ikonę SayScript (puzzel na pasku → pinezka) i kliknij ją — otworzy się panel.

Pełna instrukcja ze zdjęciowymi wskazówkami i rozwiązywaniem problemów: INSTALL.pl.md
Nie przenoś ani nie usuwaj folderu SayScript — Chrome wczytuje rozszerzenie prosto z niego.
EOF

# spróbuj otworzyć stronę rozszerzeń (jeśli jest przeglądarka i środowisko graficzne)
for B in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "$B" >/dev/null 2>&1 && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && ask "Otworzyć teraz chrome://extensions w $B?"; then
    nohup "$B" "chrome://extensions" >/dev/null 2>&1 & break
  fi
done
if [[ $PLATFORM == mac && -d "/Applications/Google Chrome.app" ]] && ask "Otworzyć teraz chrome://extensions w Chrome?"; then
  open -a "Google Chrome" "chrome://extensions" || true
fi
exit 0
