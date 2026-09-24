@echo off
rem Copies Kinema's logs from this PC onto the USB stick, next to this file.
set "DEST=%~dp0Logs from the TV PC"
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%APPDATA%\com.kinema.app\logs\*.log" "%DEST%\" >nul
if errorlevel 1 (
  echo Could not find Kinema's logs on this PC. Has Kinema been started here?
) else (
  echo Done. The logs are in "Logs from the TV PC" on the USB stick.
  echo You can unplug it now.
)
pause
