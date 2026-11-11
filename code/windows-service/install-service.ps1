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
$source = Join-Path $PSScriptRoot 'DshMeshService.cs'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Cannot find the .NET Framework C# compiler (csc.exe).' }
if (-not (Test-Path $source)) { throw "Missing $source" }

Write-Host "Compiling $exe"
& $csc /nologo /target:exe /out:$exe /r:System.ServiceProcess.dll $source
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
  Start-Sleep -Seconds 2
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
