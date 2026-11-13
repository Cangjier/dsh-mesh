param(
  [string]$ServerUrl = 'http://8.140.245.107:51821',
  [Parameter(Mandatory = $true)][string]$JoinCode,
  [string]$Interface = 'dshwg0',
  [string]$GateUrl = 'http://8.140.245.107',
  [switch]$NoJoin,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$programData = [Environment]::GetFolderPath('CommonApplicationData')
$configDir = Join-Path $programData 'dsh-mesh'
$configPath = Join-Path $configDir 'ssh-agent.json'
$wgDir = Join-Path $env:ProgramFiles 'WireGuard'
$wg = Join-Path $wgDir 'wg.exe'
$wireguard = Join-Path $wgDir 'wireguard.exe'
$tunnelConfig = Join-Path $programData "WireGuard\$Interface.conf"

# Older Windows PowerShell defaults to TLS 1.0; the gate may be HTTPS.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($GateUrl -like 'https://*' -or $ServerUrl -like 'https://*') {
  [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell.'
  }
}

function Get-Json([string]$Url) {
  $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 30
  return ($response.Content | ConvertFrom-Json)
}

function Get-AssetManifest([string]$Name) {
  # Prefer the copy in this package, then ask the gate. The gate route is
  # public so a fresh machine can fetch the WireGuard installer before joining.
  $local = Join-Path $root "gate\assets\$Name\manifest.json"
  if (Test-Path $local) {
    try { return (Get-Content -Raw -Path $local | ConvertFrom-Json) } catch { }
  }
  return (Get-Json "$($GateUrl.TrimEnd('/'))/__gate/assets/$Name")
}

function Save-Asset([string]$Name, $Asset) {
  $local = Join-Path $root "gate\assets\$Name\$($Asset.file)"
  if (Test-Path $local) {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $local).Hash.ToLowerInvariant()
    if ($hash -eq $Asset.sha256.ToLowerInvariant()) { return $local }
  }
  $target = Join-Path $env:TEMP $Asset.file
  $url = "$($GateUrl.TrimEnd('/'))/__gate/assets/$Name/$($Asset.file)"
  Write-Host "Downloading $Name from $url"
  Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing -TimeoutSec 120
  $hash = (Get-FileHash -Algorithm SHA256 -Path $target).Hash.ToLowerInvariant()
  if ($hash -ne $Asset.sha256.ToLowerInvariant()) {
    throw "Checksum mismatch for $Name ($hash != $($Asset.sha256)); refusing to install it."
  }
  return $target
}

function Ensure-WireGuard {
  if ((Test-Path $wg) -and (Test-Path $wireguard)) { return }
  Write-Host 'WireGuard is missing; installing it from the gateway static assets...'
  $manifest = Get-AssetManifest 'wireguard'
  $asset = @($manifest.assets | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'x64' } | Select-Object -First 1)
  if ($asset.Count -eq 0) { throw 'The gateway has no Windows x64 WireGuard installer.' }
  $installer = Save-Asset 'wireguard' $asset[0]
  Unblock-File -Path $installer -ErrorAction SilentlyContinue
  if ([IO.Path]::GetExtension($installer) -ne '.msi') {
    throw "Unexpected WireGuard installer type: $installer"
  }
  $log = Join-Path $env:TEMP 'dsh-wireguard-msi.log'
  Write-Host "Installing WireGuard silently: $installer"
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList "/i `"$installer`" /qn /norestart DO_NOT_LAUNCH=1 /l*v `"$log`"" -Wait -PassThru
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "WireGuard installer exited with $($process.ExitCode); see $log"
  }
  $env:Path = "$wgDir;$env:Path"
  for ($i = 0; $i -lt 30; $i++) {
    if ((Test-Path $wg) -and (Test-Path $wireguard)) { return }
    Start-Sleep -Seconds 2
  }
  throw "WireGuard was installed but $wg was not found; see $log"
}

function Wait-Interface([int]$Seconds = 30) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    try {
      $key = (& $wg show $Interface public-key 2>$null | Select-Object -First 1).Trim()
      if ($key -match '^[A-Za-z0-9+/=]{40,}$') { return $key }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return ''
}

function Join-Mesh {
  Write-Host "Joining $ServerUrl as $env:COMPUTERNAME..."
  $private = (& $wg genkey).Trim()
  $public = ($private | & $wg pubkey).Trim()
  if ($public -notmatch '^[A-Za-z0-9+/=]{40,}$') { throw 'Could not generate a WireGuard key pair.' }
  $payload = @{
    name      = $env:COMPUTERNAME
    publicKey = $public
    code      = $JoinCode
    family    = 'ipv4'
    platform  = 'windows'
  } | ConvertTo-Json -Compress
  $join = Invoke-RestMethod -Method Post -Uri "$($ServerUrl.TrimEnd('/'))/join" -ContentType 'application/json' -Body $payload -TimeoutSec 30
  if (-not $join.ok) { throw 'WireGuard join failed.' }
  $allowed = [string]$join.server.vpnCidr
  if ($join.egress) { $allowed = '0.0.0.0/0' }
  $lines = @(
    '[Interface]',
    "PrivateKey = $private",
    "Address = $($join.client.address)",
    "MTU = $($join.server.mtu)"
  )
  if ($join.server.dns) { $lines += "DNS = $($join.server.dns)" }
  $lines += '', '[Peer]',
    "PublicKey = $($join.server.publicKey)",
    "Endpoint = $($join.server.endpoint)",
    "AllowedIPs = $allowed",
    'PersistentKeepalive = 25'
  New-Item -ItemType Directory -Force (Split-Path $tunnelConfig) | Out-Null
  [IO.File]::WriteAllLines($tunnelConfig, $lines, (New-Object Text.ASCIIEncoding))
  & $wireguard /uninstalltunnelservice $Interface 2>$null | Out-Null
  & $wireguard /installtunnelservice $tunnelConfig | Out-Null
  $actual = Wait-Interface 30
  if (-not $actual) { throw "WireGuard interface $Interface did not come up." }
  if ($actual -ne $public) { throw "WireGuard returned an unexpected public key ($actual != $public)." }
  return $public
}

function Get-WireGuardPublicKey {
  $actual = Wait-Interface 5
  if ($actual) { return $actual }
  if (-not (Test-Path $tunnelConfig)) { throw "Cannot find WireGuard interface $Interface." }
  $private = (Select-String -Path $tunnelConfig -Pattern '^\s*PrivateKey\s*=\s*(.+)$' | Select-Object -First 1).Matches.Groups[1].Value.Trim()
  if (-not $private) { throw "No PrivateKey in $tunnelConfig." }
  $tmp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($tmp, $private)
    $key = (& $wg pubkey $tmp 2>$null).Trim()
    if ($key -match '^[A-Za-z0-9+/=]{40,}$') { return $key }
  } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  throw 'Could not derive the WireGuard public key.'
}

Assert-Admin
Ensure-WireGuard

$publicKey = ''
if (-not $NoJoin) {
  if ($Force -or -not (Test-Path $tunnelConfig)) {
    $publicKey = Join-Mesh
  } else {
    # The config exists; make sure its tunnel service is actually up.
    $actual = Wait-Interface 3
    if (-not $actual) {
      & $wireguard /uninstalltunnelservice $Interface 2>$null | Out-Null
      & $wireguard /installtunnelservice $tunnelConfig | Out-Null
      $actual = Wait-Interface 20
    }
    if (-not $actual) { throw "WireGuard interface $Interface is configured but did not come up." }
    $publicKey = $actual
  }
} else {
  $publicKey = Get-WireGuardPublicKey
}

New-Item -ItemType Directory -Force $configDir | Out-Null
$config = [ordered]@{
  serverUrl   = $ServerUrl.TrimEnd('/')
  publicKey   = $publicKey
  joinCode    = $JoinCode
  intervalMs  = 300000
  autoInstall = $true
}
$json = $config | ConvertTo-Json -Compress
[IO.File]::WriteAllText($configPath, $json, (New-Object Text.UTF8Encoding($false)))
Write-Host "Wrote $configPath"
Write-Host "WireGuard public key: $publicKey"

$service = Get-Service -Name 'DSH-Mesh' -ErrorAction SilentlyContinue
if ($service) {
  Write-Host 'Restarting DSH-Mesh so the LocalSystem SSH agent starts...'
  Restart-Service -Name 'DSH-Mesh' -Force
  Start-Sleep -Seconds 5
  Get-Service -Name 'DSH-Mesh' | Select-Object Name, Status
  Write-Host "Agent log: $(Join-Path $configDir 'ssh-agent.log')"
  exit 0
}

# No DSH-Mesh service: install the agent as a SYSTEM scheduled task.
$node = Join-Path $root 'runtime\node\node.exe'
$script = Join-Path $root 'code\wireguard\ssh-agent-service.js'
if (-not (Test-Path $node) -or -not (Test-Path $script)) { throw 'Missing node or ssh-agent-service.js in the package.' }
$runner = Join-Path $configDir 'run-agent.cmd'
$lines = @('@echo off', ('"' + $node + '" "' + $script + '"'))
[IO.File]::WriteAllLines($runner, $lines, (New-Object Text.ASCIIEncoding))
& schtasks.exe /Create /TN 'DSH-SSH-Agent' /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $runner /F | Out-Null
& schtasks.exe /Run /TN 'DSH-SSH-Agent' | Out-Null
Write-Host 'Installed DSH-SSH-Agent scheduled task.'
