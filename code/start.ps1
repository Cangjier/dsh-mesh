$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $Root 'config\gate.env'
if (-not (Test-Path $EnvFile)) {
  throw "Missing $EnvFile. Run install.ps1 first."
}
foreach ($line in Get-Content -Encoding UTF8 $EnvFile) {
  $trimmed = $line.Trim()
  if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
  $at = $trimmed.IndexOf('=')
  if ($at -le 0) { continue }
  $name = $trimmed.Substring(0, $at).Trim()
  $value = $trimmed.Substring($at + 1)
  Set-Item -Path "Env:$name" -Value $value
}
if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
}
$node = Join-Path $Root 'runtime\node\node.exe'
if (-not (Test-Path $node)) {
  $node = (Get-Command node -ErrorAction Stop).Source
}
$server = Join-Path $Root 'gate\server.mjs'
if (-not (Test-Path $server)) {
  throw "Missing $server. Extract the full package first."
}
Write-Host "Starting DSH Person Web with $node"
& $node $server
