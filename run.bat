@echo off
chcp 65001 >nul
cd /d "%~dp0"
set ARGS=%*

if "%ARGS%"=="" set ARGS=list

set CMD=%1
if "%CMD%"=="slots"   goto nodelayer
if "%CMD%"=="export"  goto nodelayer
if "%CMD%"=="bake"    goto nodelayer
if "%CMD%"=="backup"  goto nodelayer
if "%CMD%"=="restore" goto nodelayer
if "%CMD%"=="import" goto nodelayer

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0nvidia-presets.ps1" %ARGS%
goto done

:nodelayer
if not exist "%~dp0tool\node_modules\classic-level" (
  echo First-run: installing a small dependency...
  cd /d "%~dp0tool"
  call npm install --no-audit --no-fund >nul 2>&1
)
node "%~dp0tool\nv.mjs" %ARGS%

:done
echo.
echo ============================================
echo    Done. Press any key to close.
echo ============================================
cmd /c pause >nul