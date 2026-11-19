param(
  [string]$Root = '',
  [string]$ServiceName = 'DSH-Mesh'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$Root = (Resolve-Path $Root).Path
$exe = Join-Path $Root 'dsh-mesh-service.exe'
# Compile next to the final name, never onto it: the service that is being
# replaced has the exe open, so writing it directly fails with CS0016 ("the
# process cannot access the file") — that is how the 2026-11-19 upgrade of
# DESKTOP-678CDF3 failed and rolled back. A fresh file also means a compile
# error leaves the running service untouched.
$staged = "$exe.new"
$source = Join-Path $PSScriptRoot 'DshMeshService.cs'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Cannot find the .NET Framework C# compiler (csc.exe).' }
if (-not (Test-Path $source)) { throw "Missing $source" }

Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
Write-Host "Compiling $staged"
& $csc /nologo /target:exe /out:$staged /r:System.ServiceProcess.dll $source
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host 'Stopping a manually started gateway, if any'
foreach ($pidFile in @('data\gate.pid', 'data\dsh-web.pid')) {
  $file = Join-Path $Root $pidFile
  if (Test-Path $file) {
    $pidText = (Get-Content -Encoding UTF8 $file | Select-Object -First 1).Trim()
    if ($pidText -match '^\d+$') {
      & cmd.exe /c "taskkill /PID $pidText /T /F >nul 2>&1"
    }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2

$scheduled = Get-ScheduledTask -TaskName 'DSH Person Web' -ErrorAction SilentlyContinue
if ($scheduled) {
  try { Unregister-ScheduledTask -TaskName 'DSH Person Web' -Confirm:$false; Write-Host 'Removed the logon scheduled task' }
  catch { Write-Warning "Could not remove the scheduled task: $($_.Exception.Message)" }
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Removing existing service $ServiceName"
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  & sc.exe delete $ServiceName 2>$null | Out-Null
  # sc delete only marks it deleted; the wrapper process keeps the old exe open
  # until it actually exits, so wait for that before swapping the file.
  $exitDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $exitDeadline -and (Get-Process -Name 'dsh-mesh-service' -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Seconds 1
}

$replaceDeadline = (Get-Date).AddSeconds(20)
while ($true) {
  try {
    Move-Item -LiteralPath $staged -Destination $exe -Force -ErrorAction Stop
    break
  } catch {
    if ((Get-Date) -ge $replaceDeadline) { throw "could not replace ${exe}: $($_.Exception.Message)" }
    Start-Sleep -Milliseconds 500
  }
}

Write-Host "Creating service $ServiceName"
$binPath = '"' + $exe + '"'
& sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= 'DSH Person Web' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc create failed with exit code $LASTEXITCODE" }
& sc.exe description $ServiceName 'DSH Person Web gateway on port 80 (independent of the desktop DSH)' | Out-Null
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
& sc.exe start $ServiceName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc start failed with exit code $LASTEXITCODE" }

$deadline = (Get-Date).AddSeconds(90)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-WebRequest -Uri 'http://127.0.0.1/__gate/health' -UseBasicParsing -TimeoutSec 3
    if ($health.StatusCode -eq 200) {
      Write-Host $health.Content
      $healthy = $true
      break
    }
  } catch { }
  Start-Sleep -Seconds 3
}

Get-Service -Name $ServiceName | Select-Object Name, Status, StartType
if (-not $healthy) {
  Write-Host 'Service is installed but the gateway is not healthy yet.'
  Write-Host '--- data\service.log ---'
  Get-Content (Join-Path $Root 'data\service.log') -Tail 60 -ErrorAction SilentlyContinue
  Write-Host '--- sc query ---'
  & sc.exe query $ServiceName
  throw 'Gateway health check failed.'
}
Write-Host 'Service is running and http://127.0.0.1/ is healthy.'
