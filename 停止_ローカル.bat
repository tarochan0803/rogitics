@echo off
setlocal
chcp 65001 > nul
title LOGISTICS OS v8.0 Local Stop
color 0C

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_local.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Local stop failed.
  pause
  exit /b 1
)

echo.
pause
