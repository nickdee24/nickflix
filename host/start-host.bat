@echo off
title NickFlix Host
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed. Installing it with winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Done. Close this window and double-click start-host.bat again.
  pause
  exit /b
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo ffmpeg isn't installed. Installing it with winget...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
  echo.
  echo Done. Close this window and double-click start-host.bat again.
  pause
  exit /b
)

if not exist node_modules (
  echo Installing NickFlix Host for the first time...
  call npm install --omit=dev --no-audit --no-fund
)

:run
node src\index.js
echo.
echo NickFlix Host stopped. Restarting in 5 seconds (close this window to quit)...
timeout /t 5 >nul
goto run
