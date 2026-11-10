$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PidFile = Join-Path $Root 'data\gate.pid'
if (-not (Test-Path $PidFile)) {
  Write-Host "No running gateway pid file at $PidFile"
  return
}
$gatewayPid = [int](Get-Content -Encoding UTF8 $PidFile | Select-Object -First 1)
$process = Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue
if ($null -eq $process) {
  Write-Host "Process $gatewayPid is not running; removing stale pid file."
  Remove-Item -LiteralPath $PidFile -Force
  return
}
Stop-Process -Id $gatewayPid -Force
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Write-Host "Stopped gateway process $gatewayPid"
