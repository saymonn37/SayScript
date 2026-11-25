# SayScript - kreator instalacji (Windows)
#
# Uruchamiany przez Install-SayScript.bat (dwuklik). Nie wymaga uprawnien administratora.
#  1. pobiera przenosne PHP do folderu runtime\ (nic nie instaluje w systemie),
#  2. pobiera Composera i instaluje zaleznosci serwera,
#  3. ustawia automatyczny start serwera po zalogowaniu do Windows (ukryte okno),
#  4. uruchamia serwer i sprawdza, czy dziala, a potem prowadzi przez wgranie rozszerzenia.
# (Komunikaty celowo bez polskich znakow - zgodnosc z Windows PowerShell 5.1.)
param([int]$Port = 8165, [switch]$Uninstall, [switch]$NoAutostart)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'      # bez tego Invoke-WebRequest jest bardzo wolny
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server     = Join-Path $Root 'server'
$Scripts    = Join-Path $Root 'scripts'
$Runtime    = Join-Path $Root 'runtime'
$PhpDir     = Join-Path $Runtime 'php'
$PhpExe     = Join-Path $PhpDir 'php.exe'
$Composer   = Join-Path $Runtime 'composer.phar'
$Launcher   = Join-Path $Runtime 'run-server.cmd'
$Startup    = [Environment]::GetFolderPath('Startup')
$StartupVbs = Join-Path $Startup 'SayScript-server.vbs'
$PhpUrl     = 'https://windows.php.net/downloads/releases/latest/php-8.3-nts-Win32-vs16-x64-latest.zip'

function Step($n, $t) { Write-Host ''; Write-Host "[$n] $t" -ForegroundColor Green }
function Ok($t)       { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t)     { Write-Host "  !   $t" -ForegroundColor Yellow }
function Die($t)      { Write-Host "  BLAD: $t" -ForegroundColor Red; Read-Host 'Nacisnij Enter, aby zamknac'; exit 1 }
function Test-Port    { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $Port); $c.Close(); $true } catch { $false } }
function Stop-Server {
    # zatrzymaj tylko procesy php uruchomione z NASZEGO folderu
    Get-CimInstance Win32_Process -Filter "Name='php.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -like "$PhpDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
    Step '-' 'Usuwanie SayScript z autostartu'
    Remove-Item $StartupVbs -Force -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*run-server.cmd*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Server
    Ok 'Autostart usuniety, serwer zatrzymany. Twoje skrypty zostaly nietkniete.'
    Write-Host '  Rozszerzenie usun recznie w chrome://extensions.'
    Read-Host 'Nacisnij Enter, aby zamknac'
    exit 0
}

Write-Host '================================================'
Write-Host '  SayScript - kreator instalacji'
Write-Host '================================================'

# ------------------------------------------------------------------ 1. PHP
Step '1/4' 'Przygotowuje PHP (przenosne, w folderze runtime)'
if (-not (Test-Path $PhpExe)) {
    New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
    $zip = Join-Path $Runtime 'php.zip'
    Write-Host '  Pobieram PHP (ok. 35 MB, to chwile potrwa)...'
    try { Invoke-WebRequest -Uri $PhpUrl -OutFile $zip -UseBasicParsing }
    catch { Die "Nie udalo sie pobrac PHP. Sprawdz internet i sprobuj ponownie. ($($_.Exception.Message))" }
    Expand-Archive -Path $zip -DestinationPath $PhpDir -Force
    Remove-Item $zip -Force
    # php.ini z wlaczonymi rozszerzeniami potrzebnymi Composerowi i serwerowi
    $ini = Get-Content (Join-Path $PhpDir 'php.ini-production') -Raw
    $ini = $ini -replace '(?m)^;\s*extension_dir\s*=\s*"ext"', 'extension_dir = "ext"'
    foreach ($e in 'mbstring','openssl','curl','sockets','zip','fileinfo') {
        $ini = $ini -replace "(?m)^;\s*extension=$e\s*$", "extension=$e"
    }
    Set-Content -Path (Join-Path $PhpDir 'php.ini') -Value $ini -Encoding ASCII
}
$ver = & $PhpExe -r 'echo PHP_VERSION;'
if ($LASTEXITCODE -ne 0) { Die 'Pobrane PHP nie uruchamia sie. Brakuje "Visual C++ Redistributable 2015-2022" - zainstaluj: https://aka.ms/vs/17/release/vc_redist.x64.exe i uruchom instalator ponownie.' }
Ok "PHP $ver"

# ------------------------------------------------------------------ 2. zaleznosci
Step '2/4' 'Instaluje zaleznosci serwera (biblioteka WebSocket)'
if (-not (Test-Path (Join-Path $Server 'vendor\autoload.php'))) {
    if (-not (Test-Path $Composer)) {
        Write-Host '  Pobieram Composera...'
        try { Invoke-WebRequest -Uri 'https://getcomposer.org/composer-stable.phar' -OutFile $Composer -UseBasicParsing }
        catch { Die "Nie udalo sie pobrac Composera. ($($_.Exception.Message))" }
    }
    Push-Location $Server
    try { & $PhpExe $Composer install --no-dev --no-interaction --no-progress }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Die 'Instalacja zaleznosci nie powiodla sie (komunikat powyzej).' }
    Ok 'Zaleznosci zainstalowane.'
} else { Ok 'Zaleznosci juz sa.' }
New-Item -ItemType Directory -Force -Path $Scripts | Out-Null
Ok "Folder na skrypty: $Scripts"

# ------------------------------------------------------------------ 3. autostart
Step '3/4' 'Ustawiam automatyczne uruchamianie serwera po zalogowaniu'
if (Test-Port) { Warn "Port $Port jest zajety - zatrzymuje poprzedni serwer SayScript (jesli to on)."; Stop-Server; Start-Sleep 1 }
# launcher z petla: jesli serwer sie wywroci, wstaje ponownie po 5 s
$cmd = @"
@echo off
cd /d "$Server"
:loop
"$PhpExe" "$Server\server.php" --port=$Port --dir="$Scripts" --interval=1.0
timeout /t 5 /nobreak >nul
goto loop
"@
Set-Content -Path $Launcher -Value $cmd -Encoding ASCII
# VBS uruchamia launcher bez widocznego okna
$vbs = "CreateObject(""WScript.Shell"").Run ""cmd /c """"$Launcher"""""", 0, False"
if (-not $NoAutostart) {
    Set-Content -Path $StartupVbs -Value $vbs -Encoding ASCII
    Ok 'Dodano do autostartu Windows (folder Autostart).'
}
# uruchom teraz, bez czekania na ponowne zalogowanie
$tmp = Join-Path $Runtime 'start-now.vbs'
Set-Content -Path $tmp -Value $vbs -Encoding ASCII
Start-Process wscript.exe -ArgumentList "`"$tmp`""

# ------------------------------------------------------------------ 4. weryfikacja
Step '4/4' 'Sprawdzam, czy serwer dziala'
$up = $false
1..15 | ForEach-Object { if (-not $up) { if (Test-Port) { $up = $true } else { Start-Sleep 1 } } }
if ($up) { Ok "Serwer nasluchuje na ws://localhost:$Port" }
else {
    Warn "Serwer nie odpowiada na porcie $Port."
    Warn "Sprobuj uruchomic recznie, aby zobaczyc blad:  runtime\run-server.cmd"
    Warn 'Czesta przyczyna: antywirus/Zapora blokuje php.exe - zezwol mu na dzialanie lokalne.'
}

Write-Host ''
Write-Host 'Serwer gotowy. Zostal ostatni krok - wgranie rozszerzenia do Chrome (ok. 1 minuty):' -ForegroundColor Green
$ext = Join-Path $Root 'extension'
Write-Host @"

  1. W Chrome (lub Edge/Brave) wejdz na adres:   chrome://extensions
  2. Wlacz "Tryb programisty" (Developer mode) - przelacznik w prawym gornym rogu.
  3. Kliknij "Zaladuj rozpakowane" (Load unpacked) i wskaz folder:
       $ext
     (Jego sciezka jest juz w schowku - wklej ja Ctrl+V w oknie wyboru folderu.)
  4. Na karcie SayScript kliknij "Szczegoly" (Details) i wlacz
     "Zezwalaj na skrypty uzytkownika" (Allow user scripts).
  5. Przypnij ikone SayScript (puzzel na pasku -> pinezka) i kliknij ja - otworzy sie panel.

  Pelna instrukcja i rozwiazywanie problemow: INSTALL.pl.md
  Nie przenos ani nie usuwaj folderu SayScript - Chrome wczytuje rozszerzenie prosto z niego.
"@
try { Set-Clipboard -Value $ext } catch {}
$a = Read-Host 'Otworzyc teraz Chrome na stronie rozszerzen? [T/n]'
if ($a -eq '' -or $a -match '^[TtYy]') {
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) { Start-Process $chrome 'chrome://extensions' } else { Warn 'Nie znalazlem Chrome - otworz chrome://extensions recznie.' }
}
Start-Process explorer.exe $Root
Read-Host 'Nacisnij Enter, aby zamknac kreator'
