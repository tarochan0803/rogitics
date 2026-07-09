@echo off
setlocal
chcp 65001 > nul
title LOGISTICS OS v8.0 Deploy Menu
color 0B

set "SERVER_IP=192.168.2.116"
set "SERVER_USER=ncnadmin"
set "SERVER_DIR=/home/ncnadmin/LOGISTICS_OS_v8.0"
set "WEB_PORT=8080"
set "APP_URL=http://%SERVER_IP%:%WEB_PORT%/index9.0.html"

:MENU
cls
echo.
echo ============================================
echo   LOGISTICS OS v8.0
echo ============================================
echo   Server: %SERVER_IP%
echo.
echo  [1] Open remote app
echo  [2] Build release zip
echo  [3] Deploy zip to remote host
echo  [4] Show remote service status
echo  [5] Restart remote services
echo  [6] Exit
echo.
set /p CHOICE="Select (1-6): "

if "%CHOICE%"=="1" goto OPEN_URL
if "%CHOICE%"=="2" goto BUILD_RELEASE
if "%CHOICE%"=="3" goto DEPLOY_REMOTE
if "%CHOICE%"=="4" goto STATUS
if "%CHOICE%"=="5" goto RESTART
if "%CHOICE%"=="6" exit /b 0
goto MENU

:OPEN_URL
echo.
echo [OPEN] %APP_URL%
start "" "%APP_URL%"
pause
goto MENU

:BUILD_RELEASE
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build_release.ps1"
pause
goto MENU

:DEPLOY_REMOTE
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy_remote.ps1" -Host %SERVER_IP% -User %SERVER_USER% -RemoteDir %SERVER_DIR% -RestartServices
pause
goto MENU

:STATUS
echo.
echo [STATUS] Checking remote services...
ssh -t %SERVER_USER%@%SERVER_IP% "sudo systemctl status logistics-os logistics-yolo"
pause
goto MENU

:RESTART
echo.
echo [RESTART] Restarting remote services...
ssh -t %SERVER_USER%@%SERVER_IP% "sudo systemctl restart logistics-os logistics-yolo"
pause
goto MENU
