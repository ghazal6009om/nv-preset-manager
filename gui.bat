@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" powershell -STA -NoProfile -ExecutionPolicy Bypass -File "%~dp0nv-gui.ps1"