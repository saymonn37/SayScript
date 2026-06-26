#!/usr/bin/env bash
#
# SayScript — one-shot setup & launch.
#
# Checks prerequisites, installs Composer deps on first run, makes sure the
# scripts/ folder exists, frees the port if something is stuck on it, then
# starts the PHP WebSocket server the extension connects to (ws://localhost:3000).
#
# Usage:
#   ./start.sh                       # defaults: port 3000, ./scripts, poll 1.0s
#   ./start.sh --port 3001
#   ./start.sh --dir /path/to/scripts --interval 0.5
#   PORT=3001 ./start.sh             # env vars also work
#
set -euo pipefail

# --- locate ourselves so the script works from any cwd -----------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"

# --- defaults (overridable by env or flags) ----------------------------------
PORT="${PORT:-3000}"
SCRIPTS_DIR="${SCRIPTS_DIR:-$SCRIPT_DIR/scripts}"
INTERVAL="${INTERVAL:-1.0}"

# --- parse flags --------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)     PORT="$2"; shift 2 ;;
    --dir)      SCRIPTS_DIR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//; 1d'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- pretty output ------------------------------------------------------------
c_grn=$'\033[32m'; c_red=$'\033[31m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
info() { echo "${c_grn}▸${c_off} $*"; }
warn() { echo "${c_yel}!${c_off} $*"; }
err()  { echo "${c_red}✗ $*${c_off}" >&2; }

echo "================================================"
echo "  SayScript — setup & launch"
echo "================================================"

# --- 1. prerequisites ---------------------------------------------------------
if ! command -v php >/dev/null 2>&1; then
  err "PHP not found. Install PHP 8.1+ (e.g. 'sudo apt install php-cli')."
  exit 1
fi

PHP_VER="$(php -r 'echo PHP_VERSION;')"
if ! php -r 'exit(version_compare(PHP_VERSION, "8.1.0", ">=") ? 0 : 1);'; then
  err "PHP $PHP_VER is too old. SayScript needs PHP 8.1+."
  exit 1
fi
info "PHP $PHP_VER"

if ! command -v composer >/dev/null 2>&1; then
  err "Composer not found. Install it: https://getcomposer.org/download/"
  exit 1
fi
info "Composer $(composer --version 2>/dev/null | awk '{print $3}')"

# --- 2. install dependencies (only when missing or out of date) --------------
if [[ ! -f "$SERVER_DIR/vendor/autoload.php" ]]; then
  info "Installing PHP dependencies (cboden/ratchet)…"
  ( cd "$SERVER_DIR" && composer install --no-interaction --no-progress )
else
  info "Dependencies already installed."
fi

# --- 3. ensure scripts folder exists ------------------------------------------
if [[ ! -d "$SCRIPTS_DIR" ]]; then
  warn "Scripts folder missing — creating $SCRIPTS_DIR"
  mkdir -p "$SCRIPTS_DIR"
fi
SCRIPT_COUNT="$(find "$SCRIPTS_DIR" -maxdepth 1 -name '*.user.js' -type f 2>/dev/null | wc -l | tr -d ' ')"
info "Scripts folder: $SCRIPTS_DIR (${SCRIPT_COUNT} script(s))"

# --- 4. free the port if a stale server is holding it -------------------------
PORT_PID=""
if command -v lsof >/dev/null 2>&1; then
  PORT_PID="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  PORT_PID="$(fuser "$PORT"/tcp 2>/dev/null | tr -d ' ' || true)"
fi

if [[ -n "$PORT_PID" ]]; then
  # Only auto-kill our own previous server; otherwise refuse and warn.
  if ps -p "$PORT_PID" -o args= 2>/dev/null | grep -q "server.php"; then
    warn "Port $PORT held by a previous SayScript server (pid $PORT_PID) — stopping it."
    kill "$PORT_PID" 2>/dev/null || true
    sleep 1
  else
    err "Port $PORT is in use by another process (pid $PORT_PID). Choose another with --port."
    exit 1
  fi
fi

# --- 5. launch ----------------------------------------------------------------
echo "------------------------------------------------"
info "Starting server on ${c_grn}ws://localhost:$PORT${c_off}"
echo "${c_dim}  Load the extension/ folder at chrome://extensions (Developer mode),"
echo "  enable \"Allow user scripts\" on its Details page, then open the dashboard.${c_off}"
echo "${c_dim}  Press Ctrl+C to stop.${c_off}"
echo "------------------------------------------------"

# exec so Ctrl+C / signals go straight to PHP and the script returns its exit code
exec php "$SERVER_DIR/server.php" --port="$PORT" --dir="$SCRIPTS_DIR" --interval="$INTERVAL"
