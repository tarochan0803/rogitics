@echo off
setlocal
cd /d "%~dp0"

rem Use .venv python if present, else system python
set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

rem First run only: install deps if missing
"%PY%" -c "import numpy, PIL, fastapi, uvicorn" 1>nul 2>nul
if errorlevel 1 "%PY%" -m pip install -r "%~dp0road_seg\requirements.txt"

rem Japanese menu lives in Python (road_seg/menu.py) to avoid cmd.exe cp932 parser issues.
"%PY%" -m road_seg.menu

endlocal
