param(
  [string]$OutputDir,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$DistDir = if ($OutputDir) { $OutputDir } else { Join-Path $Root 'dist' }
$StageDir = Join-Path $DistDir "_stage_$Timestamp"
$ZipPath = Join-Path $DistDir "LOGISTICS_OS_v8.0_$Timestamp.zip"

$IncludeItems = @(
  'deploy',
  'config',
  'docs',
  'scripts',
  'server',
  'src',
  'index8.2.html',
  'index8.2.css',
  'index9.0.html',
  'index9.0.css',
  'style6.css',
  'style_patch.css',
  'runtime-config.js',
  'README.md',
  'start.sh',
  'stop.sh'
)

$IncludeItems += Get-ChildItem -Path $Root -File -Filter '*.bat' | Select-Object -ExpandProperty Name

$ExcludedDirectoryNames = @('node_modules', '__pycache__', 'output', '.git', '.venv', 'dist', 'runtime')
$ExcludedFileNames = @('user_config.js', 'runtime.local.json', 'nul')
$ExcludedExtensions = @('.pyc', '.pyo')

New-Item -ItemType Directory -Force -Path $DistDir, $StageDir | Out-Null

function Copy-RepoItem([string]$SourcePath, [string]$DestinationPath) {
  if (-not (Test-Path $SourcePath)) { return }

  if (Test-Path $SourcePath -PathType Container) {
    New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
    Get-ChildItem -Force -Path $SourcePath | ForEach-Object {
      if ($_.PSIsContainer -and $ExcludedDirectoryNames -contains $_.Name) { return }
      if (-not $_.PSIsContainer) {
        if ($ExcludedFileNames -contains $_.Name) { return }
        if ($ExcludedExtensions -contains $_.Extension) { return }
      }
      Copy-RepoItem -SourcePath $_.FullName -DestinationPath (Join-Path $DestinationPath $_.Name)
    }
    return
  }

  if ($ExcludedFileNames -contains (Split-Path $SourcePath -Leaf)) { return }
  if ($ExcludedExtensions -contains [IO.Path]::GetExtension($SourcePath)) { return }
  $parent = Split-Path -Parent $DestinationPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Copy-Item -Force -Path $SourcePath -Destination $DestinationPath
}

foreach ($item in $IncludeItems) {
  Copy-RepoItem -SourcePath (Join-Path $Root $item) -DestinationPath (Join-Path $StageDir $item)
}

if (Test-Path $ZipPath) {
  Remove-Item $ZipPath -Force
}
Compress-Archive -Path (Join-Path $StageDir '*') -DestinationPath $ZipPath -Force
Remove-Item -Recurse -Force $StageDir

if (-not $Quiet) {
  Write-Host "[release] created: $ZipPath"
}

Write-Output $ZipPath
