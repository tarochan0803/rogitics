@echo off
setlocal
cd /d "%~dp0"

set "PYTHON=python"
set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"

if not exist "%PY%" (
  "%PYTHON%" -m venv "%VENV%"
  if errorlevel 1 (
    echo Python 3.11+ が見つかりません。Python をインストールしてから再実行してください。
    pause
    exit /b 1
  )
)

"%PY%" -c "import numpy, PIL, fastapi, uvicorn" 1>nul 2>nul
if errorlevel 1 (
  "%PY%" -m pip install --upgrade pip
  "%PY%" -m pip install -r "%~dp0road_seg\requirements.txt"
  if errorlevel 1 (
    echo 依存パッケージのインストールに失敗しました。
    pause
    exit /b 1
  )
)

"%PY%" -m road_seg.menu
endlocal
