/** SSH access helpers for WireGuard peers. */

/** Linux usernames accepted by the panel. */
export const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

/**
 * Build the command the operator pastes on the client. It adds the server's
 * public key to the chosen user's authorized_keys. The server private key is
 * never part of this command.
 * @param {string} user target Linux username.
 * @param {string} publicKey SSH public key generated on the server.
 * @returns {string} one-line shell command.
 */
export function buildSshAuthorizeCommand(user: string, publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  const key = parts.slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) {
    throw new Error('Unexpected SSH public key format.');
  }
  return `u='${user}'; h=$(awk -F: -v u="$u" '$1==u{print $6; exit}' /etc/passwd); [ -n "$h" ] || { echo "No such user: $u" >&2; exit 1; }; S=""; [ "$(id -u)" -ne 0 ] && S="sudo"; $S sh -c 'mkdir -p "$1/.ssh" && chmod 700 "$1/.ssh" && touch "$1/.ssh/authorized_keys" && { grep -qxF "$2" "$1/.ssh/authorized_keys" || printf "%s\\n" "$2" >> "$1/.ssh/authorized_keys"; } && chown -R "$3" "$1/.ssh" && chmod 600 "$1/.ssh/authorized_keys"' sh "$h" '${key}' '${user}' && echo "SSH key installed for $u"`;
}

/**
 * PowerShell command that installs the server public key on a Windows client.
 * It writes the administrators_authorized_keys file (used by Windows OpenSSH
 * for admin accounts) and the target user's own authorized_keys file, then
 * fixes the administrator file's ACL. The command is base64-encoded for
 * `powershell -EncodedCommand`, so it can be pasted into cmd.exe or a
 * PowerShell prompt without quote-escaping problems.
 * @param user target Windows username.
 * @param publicKey SSH public key generated on the server.
 * @returns one-line cmd/PowerShell command.
 */
export function buildWindowsSshAuthorizeCommand(user: string, publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  const key = parts.slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) {
    throw new Error('Unexpected SSH public key format.');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(user)) {
    throw new Error('Unexpected Windows username.');
  }
  const quote = (value: string) => value.replace(/'/g, "''");
  const script = `$ErrorActionPreference = 'Stop'
$key = '${quote(key)}'
$user = '${quote(user)}'
$admin = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
$userFile = Join-Path (Join-Path 'C:\\Users' $user) '.ssh\\authorized_keys'
foreach ($path in @($admin, $userFile)) {
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  if (-not (Test-Path $path)) { New-Item -ItemType File -Path $path | Out-Null }
  $lines = @(Get-Content $path -ErrorAction SilentlyContinue)
  if ($lines -notcontains $key) { Add-Content -Path $path -Value $key -Encoding ascii }
}
icacls $admin /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
Write-Output 'SSH public key installed for Windows user ' + $user`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}
