@echo off
REM SayScript - Windows installer wizard. Just double-click this file.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
