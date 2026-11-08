@echo off
setlocal EnableExtensions
title NickFlix Host Setup
rem ===================================================================
rem  NickFlix Host Setup - one file to share with whoever hosts movies.
rem  Installs what's needed, downloads NickFlix Host, asks for the host
rem  secret and the movie folder, adds a desktop shortcut and starts it.
rem  Safe to run again later to update.
rem ===================================================================

set "REPO_ZIP=https://github.com/nickdee24/nickflix/archive/refs/heads/main.zip"
set "DEST=%USERPROFILE%\NickFlix Host"

echo.
echo   ======================================
echo     NickFlix Host Setup
echo   ======================================
echo.
echo   This sets up your PC to stream movies to Screen 1.
echo   It will be installed in: %DEST%
echo.

rem ---- 1. Node.js and ffmpeg --------------------------------------------
where winget >nul 2>nul
if errorlevel 1 (
  echo   [x] winget isn't available on this PC. Install "App Installer" from the
  echo       Microsoft Store, then run this setup again.
  goto :fail
)

where node >nul 2>nul
if errorlevel 1 (
  echo   [1/4] Installing Node.js...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  call :refreshpath
)
where node >nul 2>nul
if errorlevel 1 (
  echo   [x] Node.js didn't install. Restart the PC and run this setup again.
  goto :fail
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo   [1/4] Installing ffmpeg...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements --silent
  call :refreshpath
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo   [x] ffmpeg didn't install. Restart the PC and run this setup again.
  goto :fail
)
echo   [1/4] Node.js and ffmpeg are ready.

rem ---- 2. Download NickFlix Host ----------------------------------------
echo   [2/4] Downloading NickFlix Host...
set "TMPDIR=%TEMP%\nickflix-setup-%RANDOM%"
mkdir "%TMPDIR%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -UseBasicParsing '%REPO_ZIP%' -OutFile '%TMPDIR%\nickflix.zip'; Expand-Archive -Force '%TMPDIR%\nickflix.zip' '%TMPDIR%' } catch { exit 1 }"
if errorlevel 1 (
  echo   [x] Download failed. Check the internet connection and try again.
  goto :fail
)
if not exist "%DEST%" mkdir "%DEST%"
rem Copy the app, keeping any existing config.json, installed packages and cache.
robocopy "%TMPDIR%\nickflix-main\host" "%DEST%" /E /NFL /NDL /NJH /NJS /NP /XF config.json /XD node_modules bin >nul
rmdir /s /q "%TMPDIR%" >nul 2>nul
pushd "%DEST%"
call npm install --omit=dev --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  popd
  echo   [x] Couldn't install NickFlix Host's packages.
  goto :fail
)

rem ---- 3. Secret and movie folder ---------------------------------------
echo.
echo   [3/4] Two quick questions.
echo.
if exist config.json (
  echo   You already have settings. Press Enter on either question to keep them.
  echo.
)
set "SECRET="
set /p "SECRET=  Paste the host secret (ask the person who runs the site): "
echo.
echo   Now pick the folder your movies are in (a window will open)...
set "MEDIA="
for /f "usebackq delims=" %%F in (`powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Pick the folder with your movies'; $d.ShowNewFolderButton = $false; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"`) do set "MEDIA=%%F"
if not defined MEDIA (
  set /p "MEDIA=  No folder picked. Type the folder path instead, or press Enter to keep: "
)

set "ARGS="
if defined SECRET set ARGS=--secret "%SECRET%"
if defined MEDIA set ARGS=%ARGS% --media "%MEDIA%"
echo.
node src\setup.js %ARGS%
if errorlevel 1 (
  popd
  echo   [x] Couldn't save the settings.
  goto :fail
)

rem ---- 4. Desktop shortcut and start ------------------------------------
echo   [4/4] Adding a "NickFlix Host" shortcut to your desktop...
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\NickFlix Host.lnk'); $s.TargetPath = '%DEST%\start-host.bat'; $s.WorkingDirectory = '%DEST%'; $s.Description = 'Stream movies to NickFlix Screen 1'; $s.Save()" >nul 2>nul

echo.
echo   All set! Starting NickFlix Host now. Next time, just double-click
echo   "NickFlix Host" on your desktop. Keep its window open while you watch.
echo.
pause
start "NickFlix Host" "%DEST%\start-host.bat"
popd
exit /b 0

:refreshpath
rem Pick up PATH changes from installers without reopening the window.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"
exit /b 0

:fail
echo.
pause
exit /b 1
