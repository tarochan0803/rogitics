param(
  [Parameter(Mandatory = $true)][string]$Host,
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$RemoteDir,
  [string]$ZipPath = '',
  [switch]$RestartServices,
  [string[]]$Services = @('logistics-os', 'logistics-yolo')
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
  throw 'scp was not found in PATH'
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  throw 'ssh was not found in PATH'
}

$ScriptDir = $PSScriptRoot

if (-not $ZipPath) {
  $ZipPath = (& (Join-Path $ScriptDir 'build_release.ps1') -Quiet | Select-Object -Last 1).Trim()
}

if (-not (Test-Path $ZipPath)) {
  throw "Release zip was not found: $ZipPath"
}

$ZipName = Split-Path $ZipPath -Leaf

Write-Host "[deploy] uploading $ZipName"
scp $ZipPath "${User}@${Host}:$RemoteDir/$ZipName"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed with exit code $LASTEXITCODE"
}

$remoteExtract = "cd '$RemoteDir' && unzip -o '$ZipName' && rm '$ZipName'"
Write-Host "[deploy] extracting on remote host"
ssh "$User@$Host" $remoteExtract
if ($LASTEXITCODE -ne 0) {
  throw "remote extract failed with exit code $LASTEXITCODE"
}

if ($RestartServices) {
  $serviceText = ($Services | Where-Object { $_ }) -join ' '
  if ($serviceText) {
    Write-Host "[deploy] restarting services: $serviceText"
    ssh "$User@$Host" "sudo systemctl restart $serviceText && sudo systemctl status $serviceText --no-pager"
    if ($LASTEXITCODE -ne 0) {
      throw "remote restart failed with exit code $LASTEXITCODE"
    }
  }
}

Write-Host "[deploy] done"
