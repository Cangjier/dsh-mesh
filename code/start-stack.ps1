# Start the whole DSH stack inside the interactive session.
#
# The DSH service normally starts this stack in session 0, where the sandbox has
# no logon SID and nothing can touch the desktop. The service hands the job to a
# scheduled task with an interactive token when an administrator is logged on;
# this script is what that task runs. It owns both children so stopping the task
# stops everything.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:DSH_PACKAGE_ROOT = $Root
$EnvFile = Join-Path $Root 'config\gate.env'
if (-not (Test-Path $EnvFile)) { throw "Missing $EnvFile. Deploy or install this member first." }
foreach ($line in Get-Content -Encoding UTF8 $EnvFile) {
  $trimmed = $line.Trim()
  if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
  $at = $trimmed.IndexOf('=')
  if ($at -le 0) { continue }
  $name = $trimmed.Substring(0, $at).Trim()
  $value = $trimmed.Substring($at + 1)
  Set-Item -Path "Env:$name" -Value $value
}
$node = Join-Path $Root 'runtime\node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }

$interop = $null
$interopScript = Join-Path $Root 'code\interop-service\server.mjs'
if (Test-Path $interopScript) {
  $interop = Start-Process -FilePath $node -ArgumentList @($interopScript) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
}
try {
  & $node (Join-Path $Root 'gate\server.mjs')
} finally {
  if ($interop -and -not $interop.HasExited) {
    Stop-Process -Id $interop.Id -Force -ErrorAction SilentlyContinue
  }
}
