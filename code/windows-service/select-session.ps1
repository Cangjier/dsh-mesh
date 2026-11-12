# Decide where the DSH stack should run on this Windows host.
#
# The service runs as LocalSystem in session 0, where DSH's sandbox cannot start
# (no logon SID), screenshots are black and no GUI browser can be launched. When
# an administrator is logged on interactively, the service starts the stack as
# that user instead, through a scheduled task with an interactive token.
#
# Prints exactly one line:
#   interactive <user>     an interactive administrator is available
#   session0 <reason>      stay in session 0 (no user, not admin, or disabled)
param(
  [string]$Mode = 'auto'
)
$ErrorActionPreference = 'SilentlyContinue'

if ($Mode -eq 'session0') { Write-Output 'session0 forced by configuration'; exit 0 }

$user = ''
try {
  $computer = Get-CimInstance -ClassName Win32_ComputerSystem
  if ($computer -and $computer.UserName) { $user = $computer.UserName }
} catch { }

if ([string]::IsNullOrWhiteSpace($user)) {
  Write-Output 'session0 no interactive user is logged on'
  exit 0
}

$short = $user
if ($short.Contains('\')) { $short = $short.Split('\')[-1] }

$admin = $false
try {
  $members = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | ForEach-Object { $_.Name })
  foreach ($member in $members) {
    $name = $member
    if ($name.Contains('\')) { $name = $name.Split('\')[-1] }
    if ($name -ieq $short) { $admin = $true; break }
  }
} catch {
  # The Administrators group cannot be read: treat the account as not elevated
  # rather than promoting into a session that cannot bind port 80.
  Write-Output 'session0 cannot read the Administrators group'
  exit 0
}

if (-not $admin) {
  Write-Output ("session0 {0} is not an administrator" -f $short)
  exit 0
}

Write-Output ("interactive {0}" -f $short)
