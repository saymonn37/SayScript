# SayScript — instalacja krok po kroku (dla każdego)

Nie musisz znać się na programowaniu. Cała instalacja to **3 kroki** i ok. 5 minut.
Potrzebujesz: komputera z **Windows 10/11, Linuksem lub macOS**, przeglądarki
**Chrome, Edge lub Brave (wersja 120 lub nowsza)** i internetu (tylko na czas instalacji).

> **Co to właściwie jest?** SayScript to menedżer „skryptów użytkownika” (jak Tampermonkey),
> który trzyma skrypty jako zwykłe pliki w folderze. Składa się z dwóch części:
> małego **serwera** działającego w tle na Twoim komputerze oraz **rozszerzenia** w przeglądarce.
> Nic nie wychodzi poza Twój komputer — serwer słucha tylko lokalnie.

---

## Krok 1 — Pobierz program

1. Wejdź na https://github.com/saymonn37/SayScript
2. Kliknij zielony przycisk **Code → Download ZIP**.
3. **Rozpakuj** pobrany plik gdziekolwiek (np. w Pobranych) — to tylko folder startowy.

> ℹ️ Kreator **skopiuje aplikację do stałego katalogu** i stamtąd będzie działać, więc po
> instalacji możesz pobrany folder usunąć:
>
> | System | Gdzie jest zainstalowana aplikacja |
> |---|---|
> | Windows | `%LOCALAPPDATA%\SayScript` (czyli `C:\Users\<Ty>\AppData\Local\SayScript`) |
> | Linux | `~/.local/share/sayscript` |
> | macOS | `~/Library/Application Support/SayScript` |
>
> Tam też leży Twój folder `scripts/` i tam wskazujesz rozszerzenie w Chrome (krok 3).

## Krok 2 — Uruchom kreator instalacji (serwer)

### Windows
Kliknij dwukrotnie **`Install-SayScript.bat`**.

- Jeśli Windows pokaże niebieskie okno *„System Windows ochronił ten komputer”* →
  kliknij **Więcej informacji → Uruchom mimo to**. (To zwykły skrypt tekstowy, możesz
  go otworzyć w Notatniku i sprawdzić.)
- Kreator sam pobierze przenośne PHP (~35 MB), doinstaluje potrzebne biblioteki i ustawi
  serwer tak, żeby **włączał się sam po każdym zalogowaniu do Windows** (bez okienka).
  Nie instaluje niczego w systemie i **nie wymaga praw administratora**.
- Na końcu zobaczysz zielone `OK  Serwer nasluchuje na ws://localhost:8165`.
- Gdyby wyskoczył błąd o brakującym `VCRUNTIME140.dll`, zainstaluj
  [Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe)
  i uruchom kreator jeszcze raz.

### Linux / macOS
Otwórz terminal w rozpakowanym folderze i wpisz:

```bash
./install.sh
```

Kreator sprawdzi PHP (jeśli go brak — zaproponuje instalację), doinstaluje biblioteki
i ustawi serwer jako usługę startującą po zalogowaniu (Linux: `systemd --user`,
macOS: `launchd`). **Nie potrzebuje roota** — `sudo` jest używane wyłącznie, jeśli zgodzisz
się na doinstalowanie PHP.

## Krok 3 — Dodaj rozszerzenie do Chrome

Przeglądarka nie pozwala instalować takich rozszerzeń jednym kliknięciem, więc robi się to
ręcznie („Załaduj rozpakowane”). Kreator pokazuje te same kroki na końcu:

1. Wpisz w pasek adresu: **`chrome://extensions`** i naciśnij Enter
   (w Edge: `edge://extensions`, w Brave: `brave://extensions`).
2. Włącz **Tryb programisty** (*Developer mode*) — przełącznik **w prawym górnym rogu**.
3. Kliknij **Załaduj rozpakowane** (*Load unpacked*) i wybierz folder **`extension`**
   wewnątrz **stałego katalogu aplikacji** z tabeli wyżej
   (np. `C:\Users\<Ty>\AppData\Local\SayScript\extension`; kreator wkleja tę ścieżkę do schowka
   i wypisuje ją na końcu).
   Wybierasz sam folder `extension`, **nie** plik i nie cały SayScript.
   (W oknie wyboru folderu w Windows `AppData` jest ukryty — wklej ścieżkę Ctrl+V.)
4. Na karcie „SayScript” kliknij **Szczegóły** (*Details*) i włącz
   **Zezwalaj na skrypty użytkownika** (*Allow user scripts*).
   *Bez tego skrypty się nie uruchomią* — to najczęściej pomijany krok.
5. Kliknij ikonę puzzla na pasku Chrome i **przypnij** SayScript (pinezka).
6. Kliknij ikonę SayScript → otworzy się panel. Wskaźnik połączenia w lewym górnym
   rogu powinien być **zielony**.

Chrome może co jakiś czas wyświetlać komunikat „Wyłącz rozszerzenia w trybie programisty”.
Zamknij go (**Anuluj** / ✕) — rozszerzenie zostaje włączone.

### Zajęty port?

Serwer domyślnie używa portu **8165**. Jeśli ktoś już go zajmuje, kreator **sam znajdzie
pierwszy wolny port z zakresu 8165–8185**, uruchomi na nim serwer i zapisze go w
`extension/server-config.json`, skąd rozszerzenie go odczyta — nie musisz nic ustawiać.
Wymusić konkretny port można tak: `./install.sh --port 8170` (Windows:
`powershell -File install.ps1 -Port 8170`). Po ponownej instalacji kreator zostaje przy
wybranym wcześniej porcie. Jeśli rozszerzenie było już wgrane, po zmianie portu kliknij
ikonę odświeżenia przy SayScript w `chrome://extensions` (skrypty zostają).

## Jak z tego korzystać

- Skrypty `*.user.js` wrzucasz do folderu **`scripts/`** (albo dodajesz przyciskiem
  **+ New** w panelu, albo importujesz kopię z Tampermonkey: ⚙️ → Import).
- Zmiana pliku na dysku od razu pojawia się w panelu, a zmiana w panelu zapisuje plik.
- Zielona kropka przy skrypcie = włączony/wyłączony.
- Szczegóły funkcji: [README.md](README.md).

---

## Coś nie działa?

| Objaw | Co zrobić |
|---|---|
| Panel pokazuje **offline** / czerwony wskaźnik | Serwer nie działa. Windows: uruchom `Install-SayScript.bat` jeszcze raz. Linux: `systemctl --user status sayscript`. Uruchom kreator ponownie — sam wybierze wolny port. |
| Skrypty **nie uruchamiają się** na stronach | Włącz **Zezwalaj na skrypty użytkownika** w Szczegółach rozszerzenia (krok 3.4), potem odśwież stronę. |
| Nie widzę przełącznika „Tryb programisty” | Jesteś w zarządzanej przeglądarce (praca/szkoła) z zablokowaną opcją — użyj prywatnego profilu. |
| Opcja „Allow user scripts” nie istnieje | Przeglądarka jest zbyt stara — zaktualizuj do wersji **120+** (`chrome://settings/help`). |
| Windows: antywirus/Zapora pyta o `php.exe` | Wybierz **Zezwól** (tylko dla sieci prywatnej). Serwer słucha wyłącznie na `localhost`. |
| Po restarcie komputera serwer nie wstaje (Windows) | Sprawdź, czy w `shell:startup` (Win+R) jest plik `SayScript-server.vbs`. Jeśli nie — uruchom kreator ponownie. |
| Zmieniłem plik `server/*.php` i bez efektu | Serwer trzeba zrestartować (Windows: wyloguj się i zaloguj / zabij `php.exe`; Linux: `systemctl --user restart sayscript`). |

Ręczne uruchomienie serwera (do diagnozy, pokaże błędy w oknie), z katalogu aplikacji:
Windows — `runtime\run-server.cmd`; Linux/macOS — `./start.sh`.

## Odinstalowanie

- **Windows:** dwuklik **`Uninstall-SayScript.bat`** (w katalogu aplikacji; usuwa autostart i zatrzymuje serwer).
- **Linux/macOS:** `~/.local/share/sayscript/install.sh --uninstall` (macOS: w `~/Library/Application Support/SayScript`)
- Potem usuń rozszerzenie w `chrome://extensions` i (opcjonalnie) katalog aplikacji.
  **Twoje skrypty są w jego podfolderze `scripts/`** — skopiuj je wcześniej, jeśli chcesz je zachować.

## Aktualizacja

Pobierz nowy ZIP, rozpakuj go i uruchom kreator ponownie. Podmieni kod aplikacji w stałym
katalogu, a **Twoje skrypty, port i zależności zostają**. W `chrome://extensions` kliknij ikonę
odświeżenia przy SayScript.
