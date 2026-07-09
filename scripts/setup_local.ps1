param(
  [string]$Python = 'python',
  [switch]$SkipBatchInstall
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$VenvDir = Join-Path $Root '.venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$Requirements = Join-Path $Root 'server\requirements.txt'
$BatchDir = Join-Path $Root 'src\batch'

if (-not (Get-Command $Python -ErrorAction SilentlyContinue)) {
  throw "Python was not found: $Python"
}

if (-not (Test-Path $VenvPython)) {
  Write-Host "[setup] creating virtual environment: $VenvDir"
  & $Python -m venv $VenvDir
}

if (-not (Test-Path $VenvPython)) {
  throw "Virtual environment python was not created: $VenvPython"
}

Write-Host "[setup] upgrading pip"
& $VenvPython -m pip install --upgrade pip

Write-Host "[setup] installing server requirements"
& $VenvPython -m pip install -r $Requirements

if (-not $SkipBatchInstall -and (Test-Path (Join-Path $BatchDir 'package.json'))) {
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    Push-Location $BatchDir
    try {
      if (Test-Path (Join-Path $BatchDir 'package-lock.json')) {
        Write-Host "[setup] installing batch dependencies with npm ci"
        npm ci
      } else {
        Write-Host "[setup] installing batch dependencies with npm install"
        npm install
      }
    } finally {
      Pop-Location
    }
  } else {
    Write-Warning "npm was not found. Batch utilities were not installed."
  }
}

Write-Host ""
Write-Host "[setup] done"
Write-Host "next:"
Write-Host "  1. copy config/runtime.example.json to config/runtime.local.json"
Write-Host "  2. set runtime values as needed"
Write-Host "  3. run powershell -ExecutionPolicy Bypass -File .\scripts\start_local.ps1"
