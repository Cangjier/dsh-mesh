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

# The stack reads its settings from config\gate.env (gate) and config\interop.env
# (the interop service). Both live on the shared volume, so a release switch does
# not lose them. The platform profile loads them in this order, later files
# winning, and the interop file is written after the gate one.
$envFiles = @((Join-Path $Root 'config\gate.env'), (Join-Path $Root 'config\interop.env'))
if (-not (Test-Path $envFiles[0])) { throw "Missing $($envFiles[0]). Deploy or install this member first." }
foreach ($envFile in $envFiles) {
  if (-not (Test-Path $envFile)) { continue }
  foreach ($line in Get-Content -Encoding UTF8 $envFile) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $at = $trimmed.IndexOf('=')
    if ($at -le 0) { continue }
    $name = $trimmed.Substring(0, $at).Trim()
    $value = $trimmed.Substring($at + 1)
    Set-Item -Path "Env:$name" -Value $value
  }
}
$node = Join-Path $Root 'runtime\node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }

# A previous stack may have been left behind when the task was ended or the
# service was stopped mid-flight: those children keep port 80 and 8765 busy, so
# the new stack would silently serve stale code from the old release. Record the
# pids next to the shared data and reap them before starting.
$PidFile = Join-Path $Root 'data\stack-pids.json'
if (Test-Path $PidFile) {
  try {
    $previous = Get-Content -Encoding UTF8 $PidFile -Raw | ConvertFrom-Json
    foreach ($stale in @($previous.stack, $previous.interop, $previous.gate)) {
      if (-not $stale) { continue }
      $process = Get-Process -Id $stale -ErrorAction SilentlyContinue
      if ($process) {
        Write-Host "Reaping a leftover stack process $stale"
        & cmd.exe /c "taskkill /PID $stale /T /F >nul 2>&1"
      }
    }
  } catch {
    Write-Warning "Could not read $PidFile : $($_.Exception.Message)"
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

$interop = $null
$interopScript = Join-Path $Root 'code\interop-service\server.mjs'
if (Test-Path $interopScript) {
  $interop = Start-Process -FilePath $node -ArgumentList @($interopScript) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
}
$pids = @{ stack = $PID; interop = $(if ($interop) { $interop.Id } else { $null }) }
try { [System.IO.File]::WriteAllText($PidFile, ($pids | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false)) } catch { }
try {
  & $node (Join-Path $Root 'gate\server.mjs')
} finally {
  if ($interop -and -not $interop.HasExited) {
    Stop-Process -Id $interop.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}
