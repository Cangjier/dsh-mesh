$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:DSH_PACKAGE_ROOT = $Root
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
# Task Scheduler ends the task host but leaves the node children listening on
# the stack ports, and a failed promotion can leave a second stack behind. Free
# the ports before starting: a leftover node on one of them is always stale.
$ownedPorts = 80, 8765, 31280
foreach ($port in $ownedPorts) {
  $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($owner in $owners) {
    if (-not $owner -or $owner -eq $PID) { continue }
    $process = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'node') {
      & cmd.exe /c "taskkill /PID $owner /T /F >nul 2>&1"
    }
  }
}
for ($i = 0; $i -lt 30; $i++) {
  $busy = @(Get-NetTCPConnection -LocalPort $ownedPorts -State Listen -ErrorAction SilentlyContinue)
  if ($busy.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}

Write-Host "Starting DSH Person Web with $node"
& $node $server
