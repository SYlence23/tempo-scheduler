@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Demo-Load.ps1" -Count 6 -CancelAfterSeconds 30
pause
