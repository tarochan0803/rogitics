param(
  [int]$WebPort = 8080,
  [int]$YoloPort = 8001,
  [string]$BindHost = '127.0.0.1',
  [string]$Python = 'python',
  [int]$YoloStartupTimeoutSeconds = 120,
  [int]$WebStartupTimeoutSeconds = 30,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root 'runtime'
$LogDir = Join-Path $RuntimeDir 'logs'
$PidDir = Join-Path $RuntimeDir 'pids'
$RuntimeConfig = Join-Path $Root 'config\runtime.local.json'
$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'

New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir, $PidDir | Out-Null

$PythonPath = if (Test-Path $VenvPython) {
  $VenvPython
} elseif (Get-Command $Python -ErrorAction SilentlyContinue) {
  (Get-Command $Python).Source
} else {
  throw "Python was not found. Run .\scripts\setup_local.ps1 first."
}

function Test-Port([string]$CheckHost, [int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($CheckHost, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(700)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-Port([string]$CheckHost, [int]$Port, [int]$TimeoutSeconds, [string]$Name) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $CheckHost $Port) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "$Name did not become ready on ${CheckHost}:$Port"
}

function Show-LogTail([string]$Path, [int]$Lines = 40) {
  if (-not (Test-Path $Path)) { return }
  Write-Host ""
  Write-Host "[log] $Path"
  Get-Content -Path $Path -Tail $Lines -ErrorAction SilentlyContinue
}

function Start-ManagedPythonProcess(
  [string]$Name,
  [string]$WorkingDirectory,
  [string[]]$ArgumentList,
  [hashtable]$Environment,
  [string]$PidFile,
  [string]$StdOutLog,
  [string]$StdErrLog
) {
  $backup = @{}
  foreach ($key in $Environment.Keys) {
    $backup[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
  }
  try {
    $proc = Start-Process -FilePath $PythonPath `
      -ArgumentList $ArgumentList `
      -WorkingDirectory $WorkingDirectory `
      -RedirectStandardOutput $StdOutLog `
      -RedirectStandardError $StdErrLog `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    foreach ($key in $Environment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $backup[$key], 'Process')
    }
  }
  Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII
  Write-Host "[start] $Name pid=$($proc.Id)"
}

if (-not (Test-Port '127.0.0.1' $YoloPort)) {
  Start-ManagedPythonProcess `
    -Name 'YOLO' `
    -WorkingDirectory (Join-Path $Root 'server') `
    -ArgumentList @('app.py') `
    -Environment @{
      PORT = $YoloPort
      WEB_PORT = $WebPort
    } `
    -PidFile (Join-Path $PidDir 'yolo.pid') `
    -StdOutLog (Join-Path $LogDir 'yolo.out.log') `
    -StdErrLog (Join-Path $LogDir 'yolo.err.log')
  try {
    Wait-Port -CheckHost '127.0.0.1' -Port $YoloPort -TimeoutSeconds $YoloStartupTimeoutSeconds -Name 'YOLO server'
  } catch {
    Show-LogTail (Join-Path $LogDir 'yolo.err.log')
    Show-LogTail (Join-Path $LogDir 'yolo.out.log')
    throw
  }
} else {
  Write-Host "[skip] YOLO already listening on 127.0.0.1:$YoloPort"
}

if (-not (Test-Port $BindHost $WebPort)) {
  Start-ManagedPythonProcess `
    -Name 'Web' `
    -WorkingDirectory $Root `
    -ArgumentList @('web_server.py', "$WebPort") `
    -Environment @{
      LOGISTICS_HOST = $BindHost
      YOLO_PORT = $YoloPort
      WEB_PORT = $WebPort
      LOGISTICS_RUNTIME_CONFIG = $RuntimeConfig
    } `
    -PidFile (Join-Path $PidDir 'web.pid') `
    -StdOutLog (Join-Path $LogDir 'web.out.log') `
    -StdErrLog (Join-Path $LogDir 'web.err.log')
  try {
    Wait-Port -CheckHost $BindHost -Port $WebPort -TimeoutSeconds $WebStartupTimeoutSeconds -Name 'Web server'
  } catch {
    Show-LogTail (Join-Path $LogDir 'web.err.log')
    Show-LogTail (Join-Path $LogDir 'web.out.log')
    throw
  }
} else {
  Write-Host "[skip] Web already listening on ${BindHost}:$WebPort"
}

$AppUrl = "http://$BindHost`:$WebPort/index9.0.html"
Write-Host ""
Write-Host "[ready] app  : $AppUrl"
Write-Host "[ready] yolo : http://127.0.0.1:$YoloPort/status"
Write-Host "[ready] logs : $LogDir"

if (-not $NoBrowser) {
  Start-Process $AppUrl | Out-Null
}
