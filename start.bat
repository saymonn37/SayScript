@echo off
REM ============================================================
REM  SayScript - Windows launcher (setup + run)
REM  Double-click this file, or run it from a terminal.
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0server"

echo ================================================
echo   SayScript - setup ^& launch
echo ================================================

REM --- 1. prerequisites ---
where php >nul 2>nul
if errorlevel 1 (
  echo [ERROR] PHP not found in PATH.
  echo         Install PHP 8.1+ from https://windows.php.net/download/
  echo         and add its folder to your PATH.
  pause
  exit /b 1
)

where composer >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Composer not found in PATH.
  echo         Install it from https://getcomposer.org/download/
  pause
  exit /b 1
)

REM --- 2. dependencies (first run only) ---
if not exist "vendor\autoload.php" (
  echo Installing PHP dependencies ^(cboden/ratchet^)...
  call composer install --no-interaction --no-progress
  if errorlevel 1 (
    echo [ERROR] composer install failed.
    pause
    exit /b 1
  )
) else (
  echo Dependencies already installed.
)

REM --- 3. launch ---
echo ------------------------------------------------
echo   Starting server on ws://localhost:3000
echo   Load the extension\ folder at chrome://extensions
echo   ^(Developer mode ON, then "Allow user scripts" on its Details page^).
echo   Press Ctrl+C to stop.
echo ------------------------------------------------
php server.php %*

endlocal
