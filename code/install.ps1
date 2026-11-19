param(
  [string]$Root = (Join-Path $env:USERPROFILE '.dsh'),
  [int]$Port = 80,
  [string]$Password = '',
  [switch]$NoService
)

# DeepSeek Harness Web —— Windows 指针布局安装。
#
# 在解压好的离线包里运行：把当前目录安装成 <root>\releases\<id>，写好启动器、
# 指向 shared\ 的目录映射和 SCM 服务，然后启动网关与控制面板。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Root C:\dsh -Port 8080 -Password 'x'
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoService

$ErrorActionPreference = 'Stop'
$Package = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $Package 'manifest.json'))) {
  throw "$Package 不是完整安装包（缺少 manifest.json）"
}
$Node = Join-Path $Package 'runtime\node\node.exe'
if (-not (Test-Path $Node)) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
$Root = [IO.Path]::GetFullPath($Root)

# 安装和升级是同一个实现：把包放进 releases\，写启动器与目录映射，翻指针。
# 服务要等 install-service.ps1 注册后才能启动，所以这里先 --no-restart。
$upgrade = @(
  (Join-Path $Package 'code\deploy\upgrade-local.mjs'),
  '--stage', $Package,
  '--layout-root', $Root,
  '--port', "$Port",
  '--gate-port', "$Port",
  '--services', 'DSH-WireGuard-Control=control,DSH-Mesh=gate',
  '--no-restart'
)
if ($Password -ne '') { $upgrade += @('--gate-password', $Password) }
& $Node @upgrade
if ($LASTEXITCODE -ne 0) { throw "pointer switch failed (exit $LASTEXITCODE)" }
Set-Location $Root

$pointer = Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'dsh-mesh.json') | ConvertFrom-Json
$releaseDir = Join-Path $Root $pointer.active
$stableNode = Join-Path $Root 'runtime\node\node.exe'
if (-not (Test-Path $stableNode)) { $stableNode = Join-Path $releaseDir 'runtime\node\node.exe' }
if (-not (Test-Path $stableNode)) { $stableNode = $Node }

if ($NoService) {
  Write-Host "文件已准备：$Root（未注册服务）"
  exit 0
}

$serviceInstaller = Join-Path $Root 'code\windows-service\install-service.ps1'
if (-not (Test-Path $serviceInstaller)) { $serviceInstaller = Join-Path $releaseDir 'code\windows-service\install-service.ps1' }
if (-not (Test-Path $serviceInstaller)) { throw 'missing code\windows-service\install-service.ps1' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $serviceInstaller -Root $Root
if ($LASTEXITCODE -ne 0) { throw 'service installation failed' }

$controlInstaller = Join-Path $Root 'code\wireguard\windows-service\install-control-service.ps1'
if (-not (Test-Path $controlInstaller)) { $controlInstaller = Join-Path $releaseDir 'code\wireguard\windows-service\install-control-service.ps1' }
if (-not (Test-Path $controlInstaller)) { throw 'missing code\wireguard\windows-service\install-control-service.ps1' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controlInstaller -Root $Root -NodePath $stableNode -DshHome (Join-Path $Root 'shared\home')
if ($LASTEXITCODE -ne 0) { throw 'control panel installation failed' }

& sc.exe start DSH-WireGuard-Control | Out-Null
& sc.exe start DSH-Mesh | Out-Null

$deadline = (Get-Date).AddSeconds(180)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $Port + "/__gate/health") -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if (-not $healthy) { throw 'gateway health check failed' }

Write-Host "安装完成：$Root"
Write-Host "  面板：http://<本机地址>:$Port/（密码在 $Root\shared\config\gate.env）"
Write-Host '  日志：Get-Content (Join-Path $Root "data\service.log") -Tail 60'
