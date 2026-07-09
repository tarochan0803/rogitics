param()

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$PidDir = Join-Path $Root 'runtime\pids'

function Stop-ManagedProcess([string]$PidFile) {
  if (-not (Test-Path $PidFile)) { return }
  $pidText = Get-Content -Path $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pidText -and $pidText -match '^\d+$') {
    $pidValue = [int]$pidText
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "[stop] pid=$pidValue"
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Stop-RepoPythonProcesses() {
  $escapedRoot = [Regex]::Escape($Root)
  $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^python(\.exe)?$' -and (
      $_.CommandLine -match "$escapedRoot.*web_server\.py" -or
      $_.CommandLine -match "$escapedRoot.*server[\\/]+app\.py"
    )
  }

  foreach ($target in $targets) {
    $proc = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "[stop] repo python pid=$($target.ProcessId)"
      Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

Stop-ManagedProcess (Join-Path $PidDir 'web.pid')
Stop-ManagedProcess (Join-Path $PidDir 'yolo.pid')
Stop-RepoPythonProcesses

Write-Host "[stop] done"
