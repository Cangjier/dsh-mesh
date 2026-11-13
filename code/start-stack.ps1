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

# The service hands this script to a scheduled task with an interactive token so
# the sandbox has a logon SID and can reach the desktop. That token also opens a
# console window on the operator's screen, which nobody needs: hide it and send
# the gate log to data\gate.out instead.
$signature = @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
try {
  $console = Add-Type -MemberDefinition $signature -Name ConsoleWindow -Namespace DshMesh -PassThru -ErrorAction Stop
  $handle = $console::GetConsoleWindow()
  if ($handle -ne [IntPtr]::Zero) { [void]$console::ShowWindow($handle, 0) }
} catch {
  # No console (session 0 or a redirected run) means there is nothing to hide.
}

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

$interop = $null
$interopScript = Join-Path $Root 'code\interop-service\server.mjs'
if (Test-Path $interopScript) {
  $interop = Start-Process -FilePath $node -ArgumentList @($interopScript) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
}
$pids = @{ stack = $PID; interop = $(if ($interop) { $interop.Id } else { $null }) }
try { [System.IO.File]::WriteAllText($PidFile, ($pids | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false)) } catch { }
$gateLog = Join-Path $Root 'data\gate.out'
try {
  # cmd owns the redirection: Node writes to stderr on warnings, and under
  # $ErrorActionPreference = 'Stop' PowerShell would turn that into a crash.
  & cmd.exe /c "`"$node`" `"$(Join-Path $Root 'gate\server.mjs')`" >> `"$gateLog`" 2>&1"
} finally {
  if ($interop -and -not $interop.HasExited) {
    Stop-Process -Id $interop.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}
