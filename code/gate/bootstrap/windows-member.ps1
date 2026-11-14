param(
  [string]$ServerUrl = 'http://8.140.245.107:51821',
  [Parameter(Mandatory = $true)][string]$JoinCode,
  [string]$GateUrl = 'http://8.140.245.107',
  [string]$Interface = 'dshwg0',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$programData = [Environment]::GetFolderPath('CommonApplicationData')
$wgDir = Join-Path $env:ProgramFiles 'WireGuard'
$wg = Join-Path $wgDir 'wg.exe'
$wireguard = Join-Path $wgDir 'wireguard.exe'
$tunnelConfig = Join-Path $programData "WireGuard\$Interface.conf"
$sshDir = Join-Path $programData 'ssh'
$sshd = Join-Path $env:ProgramFiles 'OpenSSH\sshd.exe'
if (-not (Test-Path $sshd)) { $sshd = Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe' }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($GateUrl -like 'https://*' -or $ServerUrl -like 'https://*') {
  [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this in an elevated PowerShell window.'
  }
}

function Get-Json([string]$Url) {
  return ((Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 30).Content | ConvertFrom-Json)
}

function Get-AssetManifest([string]$Name) {
  return (Get-Json "$($GateUrl.TrimEnd('/'))/__gate/assets/$Name")
}

function Save-Asset([string]$Name, $Asset) {
  $target = Join-Path $env:TEMP $Asset.file
  $url = "$($GateUrl.TrimEnd('/'))/__gate/assets/$Name/$($Asset.file)"
  Write-Host "Downloading $Name from $url"
  Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing -TimeoutSec 300
  $hash = (Get-FileHash -Algorithm SHA256 -Path $target).Hash.ToLowerInvariant()
  if ($hash -ne ([string]$Asset.sha256).ToLowerInvariant()) {
    throw "Checksum mismatch for $Name ($hash != $($Asset.sha256))."
  }
  Unblock-File -Path $target -ErrorAction SilentlyContinue
  return $target
}

function Invoke-WireGuardCli {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$WireGuardArgs)
  $previous = $ErrorActionPreference
  # Native tools write progress/errors to stderr; with EAP=Stop PowerShell turns
  # that into a terminating NativeCommandError even when the exit code is 0.
  $ErrorActionPreference = 'Continue'
  try {
    $text = (& $wireguard @WireGuardArgs 2>&1 | Out-String).Trim()
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $text }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Install-TunnelService {
  # The tunnel service usually does not exist yet (fresh install); its absence
  # is expected and must not abort the bootstrap.
  Invoke-WireGuardCli '/uninstalltunnelservice' $Interface | Out-Null
  $install = Invoke-WireGuardCli '/installtunnelservice' $tunnelConfig
  if ($install.ExitCode -ne 0) {
    throw "wireguard.exe /installtunnelservice failed ($($install.ExitCode)): $($install.Output)"
  }
}

function Install-WireGuard {
  if ((Test-Path $wg) -and (Test-Path $wireguard)) { return }
  Write-Host 'WireGuard is missing; installing it from the gateway.'
  $manifest = Get-AssetManifest 'wireguard'
  $asset = @($manifest.assets | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'x64' } | Select-Object -First 1)
  if ($asset.Count -eq 0) { throw 'No Windows x64 WireGuard installer is hosted by the gateway.' }
  $msi = Save-Asset 'wireguard' $asset[0]
  $log = Join-Path $env:TEMP 'dsh-wireguard-msi.log'
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList "/i `"$msi`" /qn /norestart DO_NOT_LAUNCH=1 /l*v `"$log`"" -Wait -PassThru
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    throw "WireGuard installer exited with $($process.ExitCode); see $log"
  }
  for ($i = 0; $i -lt 30; $i++) {
    if ((Test-Path $wg) -and (Test-Path $wireguard)) { return }
    Start-Sleep -Seconds 2
  }
  throw "WireGuard was installed but $wg was not found; see $log"
}

function Get-TunnelPublicKey {
  try {
    $line = @(& $wg show $Interface public-key 2>$null | Select-Object -First 1)
    if ($line.Count -eq 0) { return '' }
    $key = ([string]$line[0]).Trim()
    if ($key -match '^[A-Za-z0-9+/=]{40,}$') { return $key }
  } catch { }
  return ''
}

function Get-PublicKey([string]$PrivateKey) {
  # wg pubkey takes the private key on stdin; it does not accept a file argument.
  # Keep stderr from becoming a terminating error on Windows PowerShell 5.1.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    return ($PrivateKey | & $wg pubkey 2>&1 | Out-String).Trim()
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Get-WireGuardKeys {
  if ((-not $Force) -and (Test-Path $tunnelConfig)) {
    $private = (Select-String -Path $tunnelConfig -Pattern '^\s*PrivateKey\s*=\s*(.+)$' | Select-Object -First 1).Matches.Groups[1].Value.Trim()
    if (-not $private) { throw "No PrivateKey in $tunnelConfig." }
    $public = Get-PublicKey $private
    if ($public -match '^[A-Za-z0-9+/=]{40,}$') { return @{ private = $private; public = $public; existing = $true } }
    Write-Warning 'Could not derive the public key from the existing WireGuard config; generating a new key pair.'
  }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $private = (& $wg genkey 2>&1 | Out-String).Trim() } finally { $ErrorActionPreference = $previous }
  if ($private -notmatch '^[A-Za-z0-9+/=]{40,}$') { throw "wg genkey failed: $private" }
  $public = Get-PublicKey $private
  if ($public -notmatch '^[A-Za-z0-9+/=]{40,}$') { throw 'Could not generate a WireGuard key pair.' }
  return @{ private = $private; public = $public; existing = $false }
}

function Join-Mesh($keys) {
  Write-Host "Joining $ServerUrl as $env:COMPUTERNAME..."
  $payload = @{
    name      = $env:COMPUTERNAME
    publicKey = $keys.public
    code      = $JoinCode
    family    = 'ipv4'
    platform  = 'windows'
  } | ConvertTo-Json -Compress
  $join = Invoke-RestMethod -Method Post -Uri "$($ServerUrl.TrimEnd('/'))/join" -ContentType 'application/json' -Body $payload -TimeoutSec 30
  if (-not $join.ok) { throw 'WireGuard join failed.' }
  $token = [string]$join.sshToken
  if (-not $token) { throw 'The gateway did not return an SSH token.' }
  if ($keys.existing -and -not $Force) {
    # Keep the existing tunnel config; just make sure its service is up.
    if (-not (Get-TunnelPublicKey)) {
      Install-TunnelService
    }
  } else {
    $allowed = [string]$join.server.vpnCidr
    if ($join.egress) { $allowed = '0.0.0.0/0' }
    $lines = @(
      '[Interface]',
      "PrivateKey = $($keys.private)",
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
    Install-TunnelService
  }
  for ($i = 0; $i -lt 30; $i++) {
    if (Get-TunnelPublicKey) { break }
    Start-Sleep -Seconds 1
  }
  if (-not (Get-TunnelPublicKey)) { throw "WireGuard interface $Interface did not come up." }
  return @{ token = $token; join = $join }
}

function Get-ServerSshKey($publicKey, $token) {
  $payload = @{ publicKey = $publicKey; token = $token } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Method Post -Uri "$($ServerUrl.TrimEnd('/'))/ssh/key" -ContentType 'application/json' -Body $payload -TimeoutSec 30
  $key = [string]$result.publicKey
  if ($key -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?$') {
    throw 'The gateway returned an invalid SSH public key.'
  }
  return $key
}

function Install-OpenSsh($serverKey) {
  $dest = Join-Path $env:ProgramFiles 'OpenSSH'
  $manifest = Get-AssetManifest 'openssh'
  $wantVersion = [string]$manifest.version
  $marker = Join-Path $dest '.dsh-openssh-version'
  $haveVersion = ''
  if (Test-Path $marker) { $haveVersion = (Get-Content $marker -TotalCount 1).Trim() }
  $installed = (Test-Path (Join-Path $dest 'sshd.exe')) -and ($wantVersion -ne '') -and ($haveVersion -eq $wantVersion)
  if (-not $installed) {
    if (Test-Path (Join-Path $dest 'sshd.exe')) {
      Write-Host "Replacing OpenSSH $haveVersion with $wantVersion from the gateway."
    } else {
      Write-Host "OpenSSH is missing; installing $wantVersion from the gateway."
    }
    $asset = @($manifest.assets | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'x64' } | Select-Object -First 1)
    if ($asset.Count -eq 0) { throw 'No Windows x64 OpenSSH package is hosted by the gateway.' }
    $zip = Save-Asset 'openssh' $asset[0]
    $tmp = Join-Path $env:TEMP ('dsh-openssh-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
      Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
      $root = Get-ChildItem $tmp -Directory | Select-Object -First 1
      $source = if ($root) { $root.FullName } else { $tmp }
      Get-Process sshd,sshd-session,sshd-auth,ssh-shellhost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      Stop-Service sshd -Force -ErrorAction SilentlyContinue
      # Re-register the service from scratch: install-sshd.ps1 also grants sshd
      # SeAssignPrimaryToken, SeTcb, SeBackup, SeRestore and SeImpersonate.
      # A bare New-Service omits them, sshd then cannot spawn its privileged
      # session process, and the listener answers with an empty host-key list.
      $previous = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        & sc.exe delete sshd 2>&1 | Out-Null
        & sc.exe delete ssh-agent 2>&1 | Out-Null
      } finally {
        $ErrorActionPreference = $previous
      }
      for ($i = 0; $i -lt 10; $i++) {
        if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
      }
      if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force $dest | Out-Null
      Copy-Item -Path (Join-Path $source '*') -Destination $dest -Recurse -Force
      $installer = Join-Path $dest 'install-sshd.ps1'
      if (Test-Path $installer) {
        Push-Location $dest
        try { & $installer } catch { Write-Warning "install-sshd.ps1: $($_.Exception.Message)" } finally { Pop-Location }
      }
      Set-Content -Path $marker -Value $wantVersion -Encoding ascii
    } finally {
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    $script:sshd = Join-Path $dest 'sshd.exe'
  }

  $keygen = Join-Path $dest 'ssh-keygen.exe'
  if (-not (Test-Path $keygen)) { throw "OpenSSH is incomplete: $keygen is missing." }
  New-Item -ItemType Directory -Force $sshDir | Out-Null
  $config = Join-Path $sshDir 'sshd_config'
  $default = Join-Path $dest 'sshd_config_default'
  if (-not (Test-Path $config) -and (Test-Path $default)) { Copy-Item $default $config -Force }

  function Repair-HostKeyAcl {
    Get-ChildItem $sshDir -Filter 'ssh_host_*_key' -File -ErrorAction SilentlyContinue |
      ForEach-Object {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
          & icacls $_.FullName /inheritance:r /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F' 2>&1 | Out-Null
          & icacls $_.FullName /setowner '*S-1-5-18' 2>&1 | Out-Null
        } finally { $ErrorActionPreference = $previous }
      }
  }

  # Host keys must load and must be owned by SYSTEM/Administrators; sshd runs
  # as LocalSystem and rejects a key owned by a normal user with
  # "no hostkeys available -- exiting". `ssh-keygen -A` creates rsa/ecdsa/
  # ed25519 without a passphrase, then FixHostFilePermissions sets owner/ACLs.
  $keyNames = @('ssh_host_rsa_key', 'ssh_host_ecdsa_key', 'ssh_host_ed25519_key')
  $needKeys = $false
  foreach ($name in $keyNames) {
    $path = Join-Path $sshDir $name
    if (-not (Test-Path $path)) { $needKeys = $true; break }
    $ownerSid = ''
    try {
      $ownerSid = (New-Object Security.Principal.NTAccount((Get-Acl $path).Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
      $ownerSid = ''
    }
    if ($ownerSid -ne 'S-1-5-18' -and $ownerSid -ne 'S-1-5-32-544') { $needKeys = $true; break }
  }
  if ($needKeys) {
    Write-Host 'Generating OpenSSH host keys.'
    Get-ChildItem $sshDir -Filter 'ssh_host_*_key*' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $generated = (& $keygen -A 2>&1 | Out-String).Trim() } finally { $ErrorActionPreference = $previous }
    if ($generated) { Write-Host $generated }
  }
  $fixScript = Join-Path $dest 'FixHostFilePermissions.ps1'
  if (Test-Path $fixScript) {
    Push-Location $dest
    try { & $fixScript -Confirm:$false } catch { Write-Warning "FixHostFilePermissions.ps1: $($_.Exception.Message)" } finally { Pop-Location }
  }
  Repair-HostKeyAcl
  foreach ($name in $keyNames) {
    if (-not (Test-Path (Join-Path $sshDir $name))) { throw "OpenSSH host key is missing after generation: $name" }
  }

  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($machinePath -split ';') -notcontains $dest) {
    [Environment]::SetEnvironmentVariable('Path', $machinePath.TrimEnd(';') + ';' + $dest, 'Machine')
  }
  $service = Get-Service sshd -ErrorAction SilentlyContinue
  if (-not $service) {
    New-Service -Name sshd -BinaryPathName ('"' + $dest + '\sshd.exe"') -StartupType Automatic -DisplayName 'OpenSSH SSH Server' | Out-Null
  } else {
    Set-Service -Name sshd -StartupType Automatic
  }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & sc.exe privs sshd SeAssignPrimaryTokenPrivilege/SeTcbPrivilege/SeBackupPrivilege/SeRestorePrivilege/SeImpersonatePrivilege 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $previous
  }

  $adminKeys = Join-Path $sshDir 'administrators_authorized_keys'
  foreach ($file in @($adminKeys, (Join-Path (Join-Path 'C:\Users' $env:USERNAME) '.ssh\authorized_keys'))) {
    New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
    if (-not (Test-Path $file)) { New-Item -ItemType File -Path $file | Out-Null }
    $lines = @(Get-Content $file -ErrorAction SilentlyContinue)
    if ($lines -notcontains $serverKey) { Add-Content -Path $file -Value $serverKey -Encoding ascii }
  }
  $fixUser = Join-Path $dest 'FixUserFilePermissions.ps1'
  if (Test-Path $fixUser) {
    Push-Location $dest
    try { & $fixUser -Confirm:$false } catch { Write-Warning "FixUserFilePermissions.ps1: $($_.Exception.Message)" } finally { Pop-Location }
  }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & icacls $adminKeys /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' 2>&1 | Out-Null
    # sshd also requires the Administrators group to own this file; a file
    # owned by the Admin user is ignored and public-key login fails.
    & icacls $adminKeys /setowner '*S-1-5-32-544' 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $previous
  }

  $firewall = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
  if (-not $firewall) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH SSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  } else {
    Enable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Out-Null
  }

  $configTest = ''
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $configTest = (& $sshd -T 2>&1 | Out-String).Trim() } finally { $ErrorActionPreference = $previous }
  if ($configTest -notmatch '(?m)^port\s+22\s*$') {
    Write-Warning "sshd -T did not report port 22: $configTest"
  }

  try {
    if ((Get-Service sshd).Status -eq 'Running') { Restart-Service sshd -Force } else { Start-Service sshd }
  } catch {
    $startError = $_.Exception.Message
    $info = ''
    $sysEvents = ''
    $debugText = ''
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $info = (& sc.exe qc sshd 2>&1 | Out-String).Trim()
      $sysEvents = ((Get-WinEvent -LogName System -MaxEvents 300 -ErrorAction SilentlyContinue |
        Where-Object { $_.ProviderName -eq 'Service Control Manager' -and $_.Message -match 'sshd|OpenSSH|SSH Server' } |
        Select-Object -First 3 | ForEach-Object { $_.Message }) -join ' | ')
      $debugLog = Join-Path $env:TEMP 'dsh-sshd-start.log'
      Remove-Item $debugLog -Force -ErrorAction SilentlyContinue
      $debugProc = Start-Process -FilePath $sshd -ArgumentList @('-ddd', '-p', '22222') -RedirectStandardError $debugLog -PassThru -NoNewWindow -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 3
      if ($debugProc -ne $null -and -not $debugProc.HasExited) { Stop-Process -Id $debugProc.Id -Force -ErrorAction SilentlyContinue }
      if (Test-Path $debugLog) {
        $debugText = ((Get-Content $debugLog -ErrorAction SilentlyContinue | Select-Object -First 25) -join ' | ')
      }
    } catch {
    } finally {
      $ErrorActionPreference = $previous
    }
    throw "sshd failed to start: $startError. Service: $info. System events: $sysEvents. Debug: $debugText"
  }
  Start-Sleep -Seconds 2
  if ((Get-Service sshd).Status -ne 'Running') { throw 'sshd did not start.' }

  # The banner alone proves nothing: verify that a real key exchange works.
  $keyscan = Join-Path $dest 'ssh-keyscan.exe'
  $scanned = ''
  for ($i = 0; $i -lt 30; $i++) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $scanned = (& $keyscan -T 5 -p 22 127.0.0.1 2>&1 | Out-String).Trim() } finally { $ErrorActionPreference = $previous }
    if ($scanned -match '(?m)^\S+ (ssh-|ecdsa-)') { return }
    Start-Sleep -Seconds 1
  }
  $present = @(Get-ChildItem $sshDir -Filter 'ssh_host_*_key' -File -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = ''
    try { $owner = (Get-Acl $_.FullName).Owner } catch { }
    "$($_.Name)=$($_.Length)B owner=$owner"
  }) -join ' '
  $conf = ''
  $events = ''
  $debugText = ''
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $conf = (& $sshd -T 2>&1 | Select-String -Pattern '^hostkey ' | ForEach-Object { $_.Line }) -join '; '
    $events = ((Get-WinEvent -LogName 'OpenSSH/Operational' -MaxEvents 80 -ErrorAction Stop |
      Where-Object { $_.Message -match 'host ?key|Unable|load|permission|denied' } |
      Select-Object -First 8 | ForEach-Object { $_.Message }) -join ' | ')
    $debugLog = Join-Path $env:TEMP 'dsh-sshd-debug.log'
    Remove-Item $debugLog -Force -ErrorAction SilentlyContinue
    $debugProc = Start-Process -FilePath $sshd -ArgumentList @('-ddd', '-p', '22222') -RedirectStandardError $debugLog -PassThru -NoNewWindow -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    if ($debugProc -ne $null -and -not $debugProc.HasExited) { Stop-Process -Id $debugProc.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path $debugLog) {
      $debugText = ((Get-Content $debugLog -ErrorAction SilentlyContinue |
        Where-Object { $_ -match 'host ?key|HostKey|Unable|load|permission|denied|error' } |
        Select-Object -First 12) -join ' | ')
    }
  } catch {
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($events.Length -gt 900) { $events = $events.Substring(0, 900) }
  if ($debugText.Length -gt 900) { $debugText = $debugText.Substring(0, 900) }
  throw "sshd is running but offered no host key. Config: $conf. Files: $present. ssh-keyscan: $scanned. Events: $events. Debug: $debugText"
}

function Report-Ssh($publicKey, $token) {
  $version = ''
  try { $version = (& $sshd -V 2>&1 | Out-String).Trim() } catch { }
  if (-not $version) { $version = 'OpenSSH' }
  $payload = @{
    publicKey   = $publicKey
    token       = $token
    user        = $env:USERNAME
    platform    = 'windows'
    hostname    = $env:COMPUTERNAME
    sshInstalled = $true
    sshRunning   = $true
    sshReady     = $true
    sshPort      = 22
    sshVersion   = $version
    sshError     = $null
  } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Method Post -Uri "$($ServerUrl.TrimEnd('/'))/ssh/report" -ContentType 'application/json' -Body $payload -TimeoutSec 30
  if (-not $result.ok) { throw 'The gateway rejected the SSH report.' }
}

function Write-ManagedBlock([string]$Path, [string]$Name, [string]$Block) {
  # Own one marker-delimited block of ~/.ssh/config and leave the rest alone.
  $text = ''
  if (Test-Path -LiteralPath $Path) { $text = [IO.File]::ReadAllText($Path) }
  $escaped = [regex]::Escape($Name)
  $pattern = "(?ms)^# >>> $escaped >>>\r?\n.*?^# <<< $escaped <<<\r?\n?"
  $text = [regex]::Replace($text, $pattern, '').TrimEnd("`r", "`n")
  if ($text.Length -gt 0) { $text += "`n" }
  [IO.File]::WriteAllText($Path, $text + $Block.TrimEnd("`r", "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
}

function Install-ReverseSsh($publicKey, $token) {
  # Enrollment is symmetric: the member keeps its own identity and the gateway
  # stores only the public half, pinned to this member's VPN address.
  Write-Host 'Preparing this member''s own SSH key for the gateway...'
  $dir = Join-Path $env:USERPROFILE '.ssh'
  New-Item -ItemType Directory -Force $dir | Out-Null
  $key = Join-Path $dir 'id_ed25519_dsh_mesh'
  $keygen = Join-Path $env:ProgramFiles 'OpenSSH\ssh-keygen.exe'
  if (-not (Test-Path $keygen)) { $keygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe' }
  if (-not (Test-Path $keygen)) { throw 'OpenSSH ssh-keygen.exe was not found.' }
  if (-not (Test-Path $key)) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $keygen -q -t ed25519 -N '""' -C "dsh-mesh@$env:COMPUTERNAME" -f $key 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
    if (-not (Test-Path $key)) { throw "ssh-keygen did not create $key" }
  }
  $memberKey = ((Get-Content -LiteralPath "$key.pub" -Raw) -split "`r?`n")[0].Trim()
  if ($memberKey -notmatch '^ssh-ed25519 ') { throw 'The member SSH public key is invalid.' }
  $payload = @{ publicKey = $publicKey; token = $token; sshPublicKey = $memberKey } | ConvertTo-Json -Compress
  $result = Invoke-RestMethod -Method Post -Uri "$($ServerUrl.TrimEnd('/'))/ssh/authorize" -ContentType 'application/json' -Body $payload -TimeoutSec 30
  if (-not $result.ok -or -not $result.host) { throw 'The gateway rejected the member SSH key.' }
  $configPath = Join-Path $dir 'config'
  $configText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$result.sshConfigB64))
  Write-ManagedBlock $configPath 'dsh-mesh:gateway' $configText
  $knownText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$result.knownHostsB64))
  if ($knownText.Trim()) {
    $knownPath = Join-Path $dir 'known_hosts'
    $existing = if (Test-Path $knownPath) { @(Get-Content -LiteralPath $knownPath) } else { @() }
    $target = [string]$result.host
    $kept = @($existing | Where-Object { $_.Trim() -ne '' -and -not (@($target, "[$target]:22") -contains $_.Trim().Split(' ')[0]) })
    $lines = @($kept) + @($knownText.Trim() -split "`r?`n")
    Set-Content -LiteralPath $knownPath -Value $lines -Encoding ascii
  }
  Write-Host "Gateway SSH key installed for $env:USERNAME ($key)"
}

Assert-Admin
Install-WireGuard
$keys = Get-WireGuardKeys
$joined = Join-Mesh $keys
$serverKey = Get-ServerSshKey $keys.public $joined.token
Install-OpenSsh $serverKey
Install-ReverseSsh $keys.public $joined.token
Report-Ssh $keys.public $joined.token

Write-Host ''
Write-Host "Ready: SSH is listening on port 22 for user $env:USERNAME."
Write-Host "WireGuard: $($keys.public)"
Write-Host "Gateway SSH key installed in $sshDir\administrators_authorized_keys"
Write-Host "This member can now run: ssh dsh-gateway"
