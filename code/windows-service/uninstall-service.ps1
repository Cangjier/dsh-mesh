param(
  [string]$ServiceName = 'DSH-Mesh'
)

$ErrorActionPreference = 'Stop'
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "Service $ServiceName is not installed."
  return
}
Write-Host "Stopping $ServiceName"
Stop-Service -Name $ServiceName -Force
Write-Host "Deleting $ServiceName"
& sc.exe delete $ServiceName | Out-Null
Write-Host "Removed $ServiceName. The gateway will not start again until start.ps1 is run manually."
