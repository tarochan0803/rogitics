@echo off
setlocal
chcp 65001 > nul
title LOGISTICS OS v8.0 Local Start
color 0A

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_local.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Local start failed.
  pause
  exit /b 1
)

echo.
pause
