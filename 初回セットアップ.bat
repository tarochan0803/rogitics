@echo off
setlocal
chcp 65001 > nul
title LOGISTICS OS v8.0 Setup
color 0B

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_local.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Setup failed.
  pause
  exit /b 1
)

echo.
pause
