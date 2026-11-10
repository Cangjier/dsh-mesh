param(
  [string]$Root = '',
  [string]$AppServiceName = 'DSH-Web-App',
  [string]$GateServiceName = 'DSH-Person-Web'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
$Root = (Resolve-Path $Root).Path
$envFile = Join-Path $Root 'config\gate.env'
if (-not (Test-Path $envFile)) { throw "missing $envFile; install the gateway once first" }
$source = Join-Path $PSScriptRoot 'DshWebAppService.cs'
$exe = Join-Path $Root 'dsh-web-app-service.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'Cannot find the .NET Framework C# compiler (csc.exe).' }

# The running service locks its executable; stop it before compiling.
Stop-Service -Name $AppServiceName -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "Compiling $exe"
& $csc /nologo /target:exe /out:$exe /r:System.ServiceProcess.dll $source
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host "Stopping $GateServiceName"
Stop-Service -Name $GateServiceName -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$existing = Get-Service -Name $AppServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Removing existing $AppServiceName"
  Stop-Service -Name $AppServiceName -Force -ErrorAction SilentlyContinue
  & sc.exe delete $AppServiceName 2>$null | Out-Null
  Start-Sleep -Seconds 2
}

Write-Host "Creating $AppServiceName"
$binPath = '"' + $exe + '"'
& sc.exe create $AppServiceName binPath= $binPath start= auto DisplayName= 'DSH Web App' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc create failed for $AppServiceName" }
& sc.exe description $AppServiceName 'Independent DSH Web process; writes data/dsh-web.json for the gateway' | Out-Null
& sc.exe failure $AppServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
& sc.exe start $AppServiceName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc start failed for $AppServiceName" }

$tokenFile = Join-Path $Root 'data\dsh-web.json'
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not (Test-Path $tokenFile)) { Start-Sleep -Seconds 2 }
if (-not (Test-Path $tokenFile)) {
  Get-Content (Join-Path $Root 'data\dsh-app-service.log') -Tail 60 -ErrorAction SilentlyContinue
  throw 'DSH Web service did not write data/dsh-web.json'
}

$text = Get-Content -LiteralPath $envFile -Raw
$text = [regex]::Replace($text, '(?m)^DSH_GATE_NO_SPAWN=.*$', 'DSH_GATE_NO_SPAWN=1')
$text = [regex]::Replace($text, '(?m)^DSH_WEB_TOKEN_FILE=.*$', "DSH_WEB_TOKEN_FILE=$tokenFile")
if ($text -notmatch '(?m)^DSH_GATE_NO_SPAWN=') { $text += "`r`nDSH_GATE_NO_SPAWN=1" }
if ($text -notmatch '(?m)^DSH_WEB_TOKEN_FILE=') { $text += "`r`nDSH_WEB_TOKEN_FILE=$tokenFile" }
Set-Content -LiteralPath $envFile -Value $text -Encoding utf8

# No SCM dependency: the gateway starts independently and simply reports a
# starting/503 state until the DSH token file appears. A dependency would make
# Windows stop the gateway whenever the DSH service stops.
Write-Host "Starting $GateServiceName in external-DSH mode"
Start-Service -Name $GateServiceName
$deadline = (Get-Date).AddSeconds(60)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-WebRequest -Uri 'http://127.0.0.1/__gate/health' -UseBasicParsing -TimeoutSec 3
    if ($health.StatusCode -eq 200) { Write-Host $health.Content; $healthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
Get-Service -Name $AppServiceName, $GateServiceName | Select-Object Name, Status, StartType
if (-not $healthy) {
  Get-Content (Join-Path $Root 'data\service.log') -Tail 80 -ErrorAction SilentlyContinue
  throw 'Gateway did not become healthy after the split.'
}
Write-Host 'Split complete: DSH-Web-App and DSH-Person-Web are independent services.'
