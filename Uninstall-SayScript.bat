@echo off
REM SayScript - removes autostart and stops the server (keeps your scripts).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
