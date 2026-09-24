@echo off
rem Runs Kinema's automatic test from this stick. Takes about two minutes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Automatic test\run.ps1"
pause
