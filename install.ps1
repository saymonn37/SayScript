# SayScript - kreator instalacji (Windows)
#
# Uruchamiany przez Install-SayScript.bat (dwuklik). Nie wymaga uprawnien administratora.
#  1. kopiuje aplikacje do stalego katalogu %LOCALAPPDATA%\SayScript (pobrany folder mozna potem usunac),
#  2. pobiera przenosne PHP do jego podfolderu runtime\ (nic nie instaluje w systemie),
#  3. pobiera Composera i instaluje zaleznosci serwera,
#  4. wybiera wolny port i ustawia automatyczny start serwera po zalogowaniu (ukryte okno),
#  5. uruchamia serwer, sprawdza, czy dziala, i prowadzi przez wgranie rozszerzenia.
# (Komunikaty celowo bez polskich znakow - zgodnosc z Windows PowerShell 5.1.)
param([int]$Port = 0, [switch]$Uninstall, [switch]$NoAutostart, [switch]$InPlace, [string]$InstallDir = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'      # bez tego Invoke-WebRequest jest bardzo wolny
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Src        = Split-Path -Parent $MyInvocation.MyCommand.Path     # skad uruchomiono (np. Pobrane\SayScript)
if ($InPlace)                        { $Root = $Src }
elseif ($InstallDir)                 { $Root = $InstallDir }
elseif ($env:SAYSCRIPT_INSTALL_DIR)  { $Root = $env:SAYSCRIPT_INSTALL_DIR }
else                                 { $Root = Join-Path $env:LOCALAPPDATA 'SayScript' }   # staly katalog aplikacji
$SameDir    = ($Root.TrimEnd('\') -ieq $Src.TrimEnd('\'))
$Server     = Join-Path $Root 'server'
$Scripts    = Join-Path $Root 'scripts'
$Runtime    = Join-Path $Root 'runtime'
$PhpDir     = Join-Path $Runtime 'php'
$PhpExe     = Join-Path $PhpDir 'php.exe'
$Composer   = Join-Path $Runtime 'composer.phar'
$Launcher   = Join-Path $Runtime 'run-server.cmd'
$Startup    = [Environment]::GetFolderPath('Startup')
$StartupVbs = Join-Path $Startup 'SayScript-server.vbs'
$OldPhpDir  = Join-Path $Src 'runtime\php'   # serwer z wczesniejszej instalacji 'w miejscu'
$PhpUrl     = 'https://windows.php.net/downloads/releases/latest/php-8.3-nts-Win32-vs16-x64-latest.zip'

function Step($n, $t) { Write-Host ''; Write-Host "[$n] $t" -ForegroundColor Green }
function Ok($t)       { Write-Host "  OK  $t" -ForegroundColor Green }
function Warn($t)     { Write-Host "  !   $t" -ForegroundColor Yellow }
function Die($t)      { Write-Host "  BLAD: $t" -ForegroundColor Red; Read-Host 'Nacisnij Enter, aby zamknac'; exit 1 }
function Test-PortNum($p) { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); $true } catch { $false } }
function Test-Port    { Test-PortNum $Port }
# czy port trzyma nasz wlasny serwer (php.exe z folderu runtime\php) - np. poprzednia instalacja
function Test-PortOurs($p) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction Stop
        return (($proc.ExecutablePath -like "$PhpDir*") -or ($proc.ExecutablePath -like "$OldPhpDir*"))
    } catch { return $false }
}
function Test-PortUsable($p) { (-not (Test-PortNum $p)) -or (Test-PortOurs $p) }
function Stop-Server {
    # zatrzymaj tylko procesy php uruchomione z NASZEGO folderu
    Get-CimInstance Win32_Process -Filter "Name='php.exe'" -ErrorAction SilentlyContinue |
        Where-Object { ($_.ExecutablePath -like "$PhpDir*") -or ($_.ExecutablePath -like "$OldPhpDir*") } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Stop-Launcher {
    # zatrzymaj petle restartu (cmd /c run-server.cmd), inaczej wskrzesilaby stary serwer
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*run-server.cmd*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
    Step '-' 'Usuwanie SayScript z autostartu'
    Remove-Item $StartupVbs -Force -ErrorAction SilentlyContinue
    Stop-Launcher
    Stop-Server
    Ok 'Autostart usuniety, serwer zatrzymany. Twoje skrypty zostaly nietkniete.'
    Write-Host "  Aby usunac aplikacje calkowicie: skopiuj skrypty z $Scripts, a potem usun folder $Root"
    Write-Host '  Rozszerzenie usun recznie w chrome://extensions.'
    Read-Host 'Nacisnij Enter, aby zamknac'
    exit 0
}

Write-Host '================================================'
Write-Host '  SayScript - kreator instalacji'
Write-Host '================================================'

# ------------------------------------------------------------------ 1. kopiowanie do stalego katalogu
if ($SameDir) {
    Step '1/5' "Tryb in-place - aplikacja zostaje w $Src"
} else {
    Step '1/5' "Instaluje aplikacje w $Root"
    New-Item -ItemType Directory -Force -Path (Join-Path $Root 'server'), $Scripts | Out-Null
    $cfgPath = Join-Path $Root 'extension\server-config.json'
    $cfgBak = $null; if (Test-Path $cfgPath) { $cfgBak = Get-Content $cfgPath -Raw }
    # kod aplikacji zawsze swiezy (skrypty uzytkownika i vendor\ zostaja)
    Remove-Item (Join-Path $Root 'extension'), (Join-Path $Server 'src') -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $Src 'extension') (Join-Path $Root 'extension') -Recurse -Force
    Remove-Item $cfgPath -Force -ErrorAction SilentlyContinue
    if ($cfgBak) { Set-Content -Path $cfgPath -Value $cfgBak.Trim() -Encoding ASCII }
    Copy-Item (Join-Path $Src 'server\src') (Join-Path $Server 'src') -Recurse -Force
    foreach ($f in 'server\server.php','server\composer.json','server\composer.lock','install.ps1','Install-SayScript.bat','Uninstall-SayScript.bat','start.bat','README.md','INSTALL.pl.md','LICENSE') {
        $from = Join-Path $Src $f
        if (Test-Path $from) { Copy-Item $from (Join-Path $Root $f) -Force }
    }
    # skopiuj skrypty uzytkownika z pobranego folderu, jesli instalacja jest jeszcze pusta (oryginaly zostaja)
    $have = @(Get-ChildItem $Scripts -Filter *.user.js -ErrorAction SilentlyContinue | Where-Object Name -ne 'example.user.js')
    $srcScripts = Join-Path $Src 'scripts'
    $srcUser = @(); if (Test-Path $srcScripts) { $srcUser = @(Get-ChildItem $srcScripts -Filter *.user.js | Where-Object Name -ne 'example.user.js') }
    if ($have.Count -eq 0 -and $srcUser.Count -gt 0) {
        Get-ChildItem $srcScripts -Force | ForEach-Object {
            $dst = Join-Path $Scripts $_.Name
            if (-not (Test-Path $dst)) { Copy-Item $_.FullName $dst -Recurse -Force }
        }
        Ok "Skopiowano Twoje skrypty z $srcScripts (oryginaly zostaja nietkniete)."
    } elseif ($have.Count -eq 0 -and (Test-Path (Join-Path $srcScripts 'example.user.js'))) {
        Copy-Item (Join-Path $srcScripts 'example.user.js') $Scripts -Force
    }
    Ok 'Aplikacja zainstalowana w stalym katalogu.'
}

# ------------------------------------------------------------------ 1. PHP
Step '2/5' 'Przygotowuje PHP (przenosne, w folderze runtime)'
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
Step '3/5' 'Instaluje zaleznosci serwera (biblioteka WebSocket)'
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
Step '4/5' 'Wybieram port i ustawiam automatyczne uruchamianie serwera'
$DefaultPort = 8165; $PoolEnd = 8185          # pula portow: 8165-8185
$ConfigJson = Join-Path $Root 'extension\server-config.json'
if ($Port -eq 0) {
    $cands = @()
    if (Test-Path $ConfigJson) { try { $cands += [int](Get-Content $ConfigJson -Raw | ConvertFrom-Json).port } catch {} }
    $cands += $DefaultPort..$PoolEnd
    $Port = ($cands | Where-Object { Test-PortUsable $_ } | Select-Object -First 1)
    if (-not $Port) { Die "Wszystkie porty $DefaultPort-$PoolEnd sa zajete. Zwolnij ktorys albo uruchom: install.ps1 -Port NUMER" }
    if ($Port -ne $DefaultPort) { Warn "Domyslny port $DefaultPort jest zajety przez inny program - uzywam wolnego portu $Port." }
} elseif (-not (Test-PortUsable $Port)) {
    Die "Port $Port jest zajety przez inny program. Wybierz inny (-Port) albo pomin ta opcje - kreator sam znajdzie wolny."
}
Ok "Port serwera: $Port"
# zapisz port dla rozszerzenia (czytany przy kazdym polaczeniu)
Set-Content -Path $ConfigJson -Value ('{"port": ' + $Port + '}') -Encoding ASCII
Ok 'Zapisano ustawienia rozszerzenia (extension\server-config.json)'
Stop-Launcher; Stop-Server; Start-Sleep 1   # zastap poprzedni serwer SayScript (petla restartu + php)
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
Step '5/5' 'Sprawdzam, czy serwer dziala'
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

  Jesli rozszerzenie bylo juz zaladowane: kliknij ikone odswiezenia przy SayScript w chrome://extensions
  (po zmianie portu to wystarczy - wszystkie skrypty zostaja).

  Pelna instrukcja i rozwiazywanie problemow: INSTALL.pl.md
  Rozszerzenie wczytuje sie z folderu podanego wyzej - nie usuwaj go ani nie przenos.
  Pobrany folder (ten, z ktorego uruchomiles kreator) mozesz juz usunac.
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
