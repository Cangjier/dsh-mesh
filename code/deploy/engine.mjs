/**
 * Blue-green SSH deployment for dsh-person-web.
 *
 * The deployment is deliberately split into two remote phases:
 *
 *   1. prepare  — upload/extract into `releases/<release>`, point shared
 *                 config/data/home/workspace at the stable `shared` directory,
 *                 update service definitions, and validate the new tree.
 *   2. activate — switch `current` to the new release, restart services with
 *                 the gateway last, and health-check. On failure the previous
 *                 release is switched back and the services are restarted.
 *
 * The gateway is always the final service to restart: a user may be reaching
 * member A through member B's gateway, so B's gateway must survive the deploy
 * for as long as possible.
 *
 * @module @local/dsh-person-web/deploy
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_APP_ROOT = {
  linux: '/opt/dsh-person-web',
  windows: 'C:\\dsh-person-web',
}

/** Services used by the split package: DSH first, gateway last. */
const DEFAULT_SERVICES = {
  linux: [
    { name: 'dsh-web-app.service', role: 'dsh', command: 'start-dsh.sh' },
    { name: 'dsh-web-gate.service', role: 'gate', command: 'start.sh' },
  ],
  windows: [
    { name: 'DSH-Web-App', role: 'dsh', command: 'dsh-web-app-service.exe' },
    { name: 'DSH-Person-Web', role: 'gate', command: 'dsh-person-web-service.exe' },
  ],
}

const ROLE_ORDER = { control: 0, dsh: 1, gate: 2 }

/**
 * Quote one value for a POSIX shell single-quoted string.
 * @param {string} value raw value.
 * @returns {string} quoted value.
 */
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Quote one value for a PowerShell single-quoted string.
 * @param {string} value raw value.
 * @returns {string} quoted value.
 */
function ps(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Hash a file without loading it into memory.
 * @param {string} file path.
 * @returns {Promise<string>} hex sha256.
 */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Normalize a target OS name.
 * @param {string} value raw os.
 * @returns {'linux'|'windows'} canonical OS.
 */
export function normalizeOs(value) {
  const text = String(value ?? '').toLowerCase()
  if (text === 'linux' || text === 'win' || text === 'windows') {
    return text.startsWith('win') ? 'windows' : 'linux'
  }
  throw new Error('os must be "linux" or "windows"')
}

/**
 * Infer a service role from its name.
 * @param {string} name service/unit name.
 * @returns {'control'|'dsh'|'gate'} role.
 */
function inferRole(name) {
  const text = String(name).toLowerCase()
  if (text.includes('wireguard') || text.includes('wg-') || text.includes('control')) return 'control'
  if (text.includes('gate')) return 'gate'
  return 'dsh'
}

/**
 * Validate and order services: control, DSH, then the gateway last.
 * @param {Array<string|{name:string,role?:string,command?:string}>|undefined} input services.
 * @param {'linux'|'windows'} os target OS.
 * @returns {Array<{name:string,role:'control'|'dsh'|'gate',command:string}>} ordered services.
 */
export function normalizeServices(input, os) {
  const source = input === undefined ? DEFAULT_SERVICES[os] : input
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error('at least one service is required')
  }
  const seen = new Set()
  const services = source.map((entry, index) => {
    const raw = typeof entry === 'string' ? { name: entry } : entry
    if (raw === null || typeof raw !== 'object' || typeof raw.name !== 'string' || raw.name.trim() === '') {
      throw new Error(`service #${String(index + 1)} needs a name`)
    }
    const name = raw.name.trim()
    if (seen.has(name)) throw new Error(`duplicate service ${name}`)
    seen.add(name)
    const role = raw.role ?? inferRole(name)
    if (!(role in ROLE_ORDER)) throw new Error(`service ${name} has unknown role ${String(role)}`)
    const command = typeof raw.command === 'string' && raw.command.trim() !== ''
      ? raw.command.trim()
      : os === 'linux' ? 'start.sh' : 'dsh-person-web-service.exe'
    return { name, role, command }
  })
  if (!services.some(service => service.role === 'gate')) {
    throw new Error('the service list must include one gateway service (role "gate")')
  }
  if (services.filter(service => service.role === 'gate').length > 1) {
    throw new Error('the service list must include exactly one gateway service')
  }
  services.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
  if (services[services.length - 1].role !== 'gate') {
    throw new Error('the gateway must be the last service to restart')
  }
  return services
}

/**
 * Find the newest matching package in `dist` when the caller omits a path.
 * @param {string} repositoryRoot package root.
 * @param {'linux'|'windows'} os target OS.
 * @returns {Promise<string>} archive path.
 */
export async function findLatestPackage(repositoryRoot, os) {
  const dist = path.join(repositoryRoot, 'dist')
  const suffix = os === 'linux' ? '.tar.gz' : '.zip'
  const prefix = `dsh-person-web-`
  const marker = `-${os === 'linux' ? 'linux' : 'win'}-x64`
  const entries = await readdir(dist).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix) || !entry.includes(marker)) continue
    const file = path.join(dist, entry)
    const info = await stat(file).catch(() => null)
    if (info?.isFile()) candidates.push({ file, mtimeMs: info.mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (candidates.length === 0) {
    throw new Error(`no ${os} package found in ${dist}; build one or pass --package`)
  }
  return candidates[0].file
}

/**
 * Build the immutable deployment plan.
 * @param {object} options deployment input.
 * @param {string} options.host SSH host.
 * @param {string} [options.user] SSH user.
 * @param {number} [options.port] SSH port.
 * @param {string} [options.identityFile] private key.
 * @param {'linux'|'windows'} [options.os] target OS.
 * @param {string} [options.package] local archive.
 * @param {string} [options.appRoot] stable application root.
 * @param {string} [options.release] release id.
 * @param {Array} [options.services] service manifest.
 * @param {'all'|'dsh'} [options.scope] which services to restart.
 * @param {string} [options.gatePort] health-check port.
 * @param {string} [options.repositoryRoot] package root.
 * @param {boolean} [options.sudo] use sudo on Linux.
 * @returns {Promise<object>} plan.
 */
export async function buildDeployPlan(options) {
  if (typeof options.host !== 'string' || options.host.trim() === '') throw new Error('host is required')
  const os = normalizeOs(options.os ?? 'linux')
  const repositoryRoot = options.repositoryRoot ?? process.cwd()
  let packagePath = ''
  let packageInfo = null
  let sha256 = ''
  if (options.skipPackage !== true) {
    packagePath = options.package
      ? path.resolve(options.package)
      : await findLatestPackage(repositoryRoot, os)
    packageInfo = await stat(packagePath)
    if (!packageInfo.isFile()) throw new Error(`package is not a file: ${packagePath}`)
    sha256 = await hashFile(packagePath)
  }
  const release = options.skipPackage === true
    ? 'rollback'
    : typeof options.release === 'string' && options.release.trim() !== ''
      ? options.release.trim()
      : `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${sha256.slice(0, 8)}`
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(release)) {
    throw new Error('release must be 3-80 chars of letters, digits, dot, underscore or dash')
  }
  const appRoot = typeof options.appRoot === 'string' && options.appRoot.trim() !== ''
    ? options.appRoot.trim()
    : DEFAULT_APP_ROOT[os]
  const services = normalizeServices(options.services, os)
  const scope = options.scope === 'dsh' ? 'dsh' : 'all'
  const gatePort = String(options.gatePort ?? '80')
  if (!/^\d{1,5}$/.test(gatePort) || Number(gatePort) > 65535) throw new Error('gatePort is invalid')
  const retention = Number.isSafeInteger(options.retention) ? options.retention : 3
  if (retention < 2) throw new Error('retention must be at least 2 (current plus previous)')
  const serviceUser = typeof options.serviceUser === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/u.test(options.serviceUser.trim())
    ? options.serviceUser.trim()
    : undefined
  return {
    host: options.host.trim(),
    user: typeof options.user === 'string' && options.user.trim() !== '' ? options.user.trim() : undefined,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === 'string' && options.identityFile.trim() !== ''
      ? path.resolve(options.identityFile)
      : undefined,
    os,
    package: { path: packagePath, bytes: packageInfo?.size ?? 0, sha256 },
    release,
    appRoot,
    serviceUser,
    shared: `${appRoot}${os === 'linux' ? '/shared' : '\\shared'}`,
    current: `${appRoot}${os === 'linux' ? '/current' : '\\current'}`,
    previous: `${appRoot}${os === 'linux' ? '/previous' : '\\previous'}`,
    releases: `${appRoot}${os === 'linux' ? '/releases' : '\\releases'}`,
    services,
    scope,
    gatePort,
    retention,
    sudo: options.sudo !== false,
    remotePackage: os === 'linux'
      ? `/tmp/dsh-person-web-${release}${path.extname(packagePath)}`
      : `C:\\Windows\\Temp\\dsh-person-web-${release}${path.extname(packagePath)}`,
  }
}

/**
 * Read the member's existing install root and service user.
 *
 * A member may have been installed by root under `/root/.dsh`, by a normal
 * user under `/home/<user>/.dsh`, or anywhere else. The systemd unit (or the
 * Windows service) is the source of truth; only when it cannot be read does
 * this fall back to the SSH user's home.
 *
 * @param {{host:string,user?:string,port?:number,identityFile?:string,os?:string}} options target.
 * @returns {Promise<{appRoot:string,serviceUser:string|undefined}>} detected install.
 */
export async function probeTarget(options) {
  if (typeof options.host !== 'string' || options.host.trim() === '') throw new Error('host is required')
  const os = normalizeOs(options.os ?? 'linux')
  const user = typeof options.user === 'string' && options.user.trim() !== '' ? options.user.trim() : undefined
  const plan = {
    host: options.host.trim(),
    user,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === 'string' && options.identityFile.trim() !== ''
      ? path.resolve(options.identityFile)
      : undefined,
    os,
  }
  const runner = new SshRunner(plan)
  if (os === 'windows') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$svc = Get-CimInstance Win32_Service -Filter \"Name='DSH-Person-Web'\"",
      "$root = ''",
      'if ($svc -and $svc.PathName) {',
      '  if ($svc.PathName -match \'^"([^"]+)"\') { $exe = $matches[1] } else { $exe = ($svc.PathName -split \' \')[0] }',
      '  $root = Split-Path -Parent $exe',
      '}',
      'if (-not $root) { $root = Join-Path $env:USERPROFILE \'.dsh\\dsh-person-web\' }',
      '$root = $root -replace \'(?i)\\\\current$\', \'\'',
      'Write-Output $root',
      'Write-Output $env:USERNAME',
    ].join('\n')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const { stdout } = await runner.runProcess('ssh', [
      ...runner.sshOptions(),
      runner.target(),
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    ])
    const [root = ''] = stdout.split(/\r?\n/u)
    const appRoot = root.trim() !== ''
      ? root.trim()
      : `C:\\Users\\${user ?? 'Public'}\\.dsh\\dsh-person-web`
    return { appRoot, serviceUser: undefined }
  }
  const script = `#!/usr/bin/env bash
set -u
root=''
runuser=''
for unit in dsh-web-gate.service dsh-web.service dsh-person-web.service; do
  if command -v systemctl >/dev/null 2>&1; then
    root=$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)
  fi
  if [ -n "$root" ]; then
    runuser=$(systemctl show "$unit" -p User --value 2>/dev/null || true)
    break
  fi
done
if [ -z "$root" ]; then
  root="$HOME/.dsh/dsh-person-web"
fi
case "$root" in
  */current) root=$(dirname "$root") ;;
esac
printf '%s\\n%s\\n' "$root" "$runuser"
`
  const { stdout } = await runner.runProcess('ssh', [
    ...runner.sshOptions(),
    runner.target(),
    'bash -s',
  ], script)
  const [root = '', serviceUser = ''] = stdout.split(/\r?\n/u)
  const fallback = user !== undefined && user !== 'root'
    ? `/home/${user}/.dsh/dsh-person-web`
    : '/root/.dsh/dsh-person-web'
  return {
    appRoot: root.trim() !== '' ? root.trim() : fallback,
    serviceUser: serviceUser.trim() !== '' ? serviceUser.trim() : undefined,
  }
}

/**
 * Build the Linux prepare script.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxPrepareScript(plan) {
  const serviceBlocks = plan.services.map(service => {
    const unit = sh(service.name)
    const command = service.command.startsWith('/') ? service.command : `${plan.appRoot}/current/${service.command}`
    return `write_unit ${unit} ${sh(command)}`
  }).join('\n')
  // Files created by the sudo prepare belong to the user the existing unit
  // runs as; otherwise a per-user member gets a root-owned tree.
  const chown = plan.serviceUser === undefined || plan.serviceUser === 'root'
    ? ''
    : `chown -R ${sh(`${plan.serviceUser}:`)} "$APP_ROOT" 2>/dev/null || true\n`
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
RELEASE=${sh(plan.release)}
PACKAGE=${sh(plan.remotePackage)}
NEW="$APP_ROOT/releases/$RELEASE"
SHARED="$APP_ROOT/shared"
CURRENT="$APP_ROOT/current"
mkdir -p "$APP_ROOT/releases" "$SHARED"
if [ -e "$NEW" ]; then
  echo "release already exists: $NEW" >&2
  exit 1
fi
mkdir -p "$NEW"
tar -xzf "$PACKAGE" -C "$NEW" --strip-components=1

# Shared mutable state stays outside every release. The first deploy copies it
# from the currently running tree; later deploys inherit it untouched.
for dir in config data home workspace; do
  if [ ! -e "$SHARED/$dir" ]; then
    if [ -e "$CURRENT/$dir" ]; then
      cp -a "$CURRENT/$dir" "$SHARED/$dir"
    else
      mkdir -p "$SHARED/$dir"
    fi
  fi
  rm -rf "$NEW/$dir"
  ln -s "$SHARED/$dir" "$NEW/$dir"
done
${chown}
ENV_FILE="$SHARED/config/gate.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE; install this member once before the first SSH deploy" >&2
  exit 1
fi
sed -i "s|^DSH_HOME=.*|DSH_HOME=$SHARED/home|" "$ENV_FILE"
sed -i "s|^DSH_WORKDIR=.*|DSH_WORKDIR=$SHARED/workspace|" "$ENV_FILE"
grep -q '^DSH_HOME=' "$ENV_FILE" || echo "DSH_HOME=$SHARED/home" >> "$ENV_FILE"
grep -q '^DSH_WORKDIR=' "$ENV_FILE" || echo "DSH_WORKDIR=$SHARED/workspace" >> "$ENV_FILE"

test -x "$NEW/runtime/node/node"
"$NEW/runtime/node/node" --check "$NEW/gate/server.mjs"
test -f "$NEW/manifest.json"

write_unit() {
  local unit="$1"
  local command="$2"
  local dropin="/etc/systemd/system/$unit.d"
  mkdir -p "$dropin"
  cat > "$dropin/dsh-release.conf" <<EOF
[Service]
WorkingDirectory=$APP_ROOT/current
ExecStart=$command
EOF
}
${serviceBlocks}
systemctl daemon-reload
echo "prepared $RELEASE at $NEW"
`
}

/**
 * Build the Linux activate script.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxActivateScript(plan) {
  const restart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `systemctl restart ${sh(service.name)}`)
    .join('\n')
  const rollbackRestart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `systemctl restart ${sh(service.name)}`)
    .join('\n')
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
RELEASE=${sh(plan.release)}
NEW="$APP_ROOT/releases/$RELEASE"
SHARED="$APP_ROOT/shared"
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
PORT=$(sed -n 's/^DSH_GATE_PORT=//p' "$SHARED/config/gate.env" | tail -n1)
PORT=\${PORT:-${plan.gatePort}}
OLD=$(readlink -f "$CURRENT" 2>/dev/null || true)
if [ -n "$OLD" ]; then
  ln -sfn "$OLD" "$PREVIOUS"
fi
ln -sfn "$NEW" "$CURRENT"

restart_services() {
${restart.split('\n').map(line => `  ${line}`).join('\n')}
}
health() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}
restart_services
if ! health; then
  echo "health check failed on $RELEASE; rolling back" >&2
  if [ -n "$OLD" ]; then
    ln -sfn "$OLD" "$CURRENT"
${rollbackRestart.split('\n').map(line => `    ${line}`).join('\n')}
    health || true
  fi
  exit 1
fi
# Retention: keep the newest N releases and never the current/previous target.
mapfile -t RELEASES < <(ls -1dt "$APP_ROOT/releases"/* 2>/dev/null || true)
for ((i=${plan.retention}; i<\${#RELEASES[@]}; i++)); do
  old="\${RELEASES[$i]}"
  [ "$(readlink -f "$CURRENT")" = "$old" ] && continue
  [ "$(readlink -f "$PREVIOUS")" = "$old" ] && continue
  rm -rf "$old" || true
done
echo "activated $RELEASE"
`
}

/**
 * Build the Linux rollback script.
 * @param {object} plan deployment plan.
 * @returns {string} shell script.
 */
export function buildLinuxRollbackScript(plan) {
  const restart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `systemctl restart ${sh(service.name)}`)
    .join('\n')
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
OLD=$(readlink -f "$PREVIOUS" 2>/dev/null || true)
if [ -z "$OLD" ]; then
  echo "no previous release to roll back to" >&2
  exit 1
fi
ln -sfn "$OLD" "$CURRENT"
${restart}
echo "rolled back to $OLD"
`
}

/**
 * Build the Windows prepare script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsPrepareScript(plan) {
  const serviceLines = plan.services.map(service => {
    const command = service.command
    return `$exe = Join-Path $New ${ps(command)}
if (-not (Test-Path $exe)) {
  $oldExe = Join-Path $Current ${ps(command)}
  if (Test-Path $oldExe) { Copy-Item $oldExe $exe -Force } else { throw "missing service binary: $exe" }
}
$binPath = $AppRoot + '\\current\\' + ${ps(command)}
& sc.exe config ${ps(service.name)} binPath= $binPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc config failed for ${service.name}" }`
  }).join('\n')
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Release = ${ps(plan.release)}
$Package = ${ps(plan.remotePackage)}
$New = Join-Path $AppRoot "releases\\$Release"
$Shared = Join-Path $AppRoot 'shared'
$Current = Join-Path $AppRoot 'current'
New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot 'releases') | Out-Null
New-Item -ItemType Directory -Force -Path $Shared | Out-Null
if (Test-Path $New) { throw "release already exists: $New" }
New-Item -ItemType Directory -Force -Path $New | Out-Null
Expand-Archive -LiteralPath $Package -DestinationPath $New -Force
$inner = Get-ChildItem -LiteralPath $New -Directory | Select-Object -First 1
if ($inner -and (Test-Path (Join-Path $inner.FullName 'manifest.json'))) {
  Get-ChildItem -LiteralPath $inner.FullName -Force | Move-Item -Destination $New -Force
  Remove-Item -LiteralPath $inner.FullName -Recurse -Force
}
foreach ($dir in @('config','data','home','workspace')) {
  $sharedPath = Join-Path $Shared $dir
  if (-not (Test-Path $sharedPath)) {
    $oldPath = Join-Path $Current $dir
    if (Test-Path $oldPath) { Copy-Item $oldPath $sharedPath -Recurse -Force } else { New-Item -ItemType Directory -Force -Path $sharedPath | Out-Null }
  }
  $newPath = Join-Path $New $dir
  if (Test-Path $newPath) { Remove-Item $newPath -Recurse -Force }
  & cmd.exe /c mklink /J "$newPath" "$sharedPath" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not link $newPath" }
}
$envFile = Join-Path $Shared 'config\\gate.env'
if (-not (Test-Path $envFile)) { throw "missing $envFile; install this member once before the first SSH deploy" }
$text = Get-Content -LiteralPath $envFile -Raw
$text = [regex]::Replace($text, '(?m)^DSH_HOME=.*$', "DSH_HOME=$Shared\\home")
$text = [regex]::Replace($text, '(?m)^DSH_WORKDIR=.*$', "DSH_WORKDIR=$Shared\\workspace")
if ($text -notmatch '(?m)^DSH_HOME=') { $text += "\`r\`nDSH_HOME=$Shared\\home" }
if ($text -notmatch '(?m)^DSH_WORKDIR=') { $text += "\`r\`nDSH_WORKDIR=$Shared\\workspace" }
Set-Content -LiteralPath $envFile -Value $text -Encoding utf8 -NoNewline
$node = Join-Path $New 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { throw "missing $node" }
& $node --check (Join-Path $New 'gate\\server.mjs')
if ($LASTEXITCODE -ne 0) { throw 'gate syntax check failed' }
${serviceLines}
Write-Output "prepared $Release at $New"
`
}

/**
 * Build the Windows activate script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsActivateScript(plan) {
  const restart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `Restart-Service -Name ${ps(service.name)} -Force`)
    .join('\n')
  const rollbackRestart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `Restart-Service -Name ${ps(service.name)} -Force -ErrorAction SilentlyContinue`)
    .join('\n')
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Release = ${ps(plan.release)}
$New = Join-Path $AppRoot "releases\\$Release"
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
$port = ${ps(plan.gatePort)}
$old = $null
if (Test-Path $Current) {
  $item = Get-Item -LiteralPath $Current -Force
  $old = $item.Target
  if ($old -is [array]) { $old = $old[0] }
}
if ($old) {
  if (Test-Path $Previous) { & cmd.exe /c rmdir "$Previous" | Out-Null }
  & cmd.exe /c mklink /J "$Previous" "$old" | Out-Null
}
if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
& cmd.exe /c mklink /J "$Current" "$New" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "could not switch current to $New" }
function Test-Health {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/__gate/health" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}
${restart}
if (-not (Test-Health)) {
  Write-Error "health check failed on $Release; rolling back"
  if ($old) {
    if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
    & cmd.exe /c mklink /J "$Current" "$old" | Out-Null
${rollbackRestart}
    Test-Health | Out-Null
  }
  exit 1
}
# Retention: keep the newest N releases and never the current/previous target.
$keep = ${plan.retention}
$currentTarget = $null
$previousTarget = $null
if (Test-Path $Current) { $currentTarget = (Get-Item -LiteralPath $Current -Force).Target }
if (Test-Path $Previous) { $previousTarget = (Get-Item -LiteralPath $Previous -Force).Target }
if ($currentTarget -is [array]) { $currentTarget = $currentTarget[0] }
if ($previousTarget -is [array]) { $previousTarget = $previousTarget[0] }
Get-ChildItem -LiteralPath (Join-Path $AppRoot 'releases') -Directory |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $keep |
  ForEach-Object {
    if ($_.FullName -ne $currentTarget -and $_.FullName -ne $previousTarget) {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
Write-Output "activated $Release"
`
}

/**
 * Build the Windows rollback script.
 * @param {object} plan deployment plan.
 * @returns {string} PowerShell script.
 */
export function buildWindowsRollbackScript(plan) {
  const restart = plan.services
    .filter(service => plan.scope === 'all' || service.role !== 'gate')
    .map(service => `Restart-Service -Name ${ps(service.name)} -Force`)
    .join('\n')
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
if (-not (Test-Path $Previous)) { throw 'no previous release to roll back to' }
$old = (Get-Item -LiteralPath $Previous -Force).Target
if ($old -is [array]) { $old = $old[0] }
if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
& cmd.exe /c mklink /J "$Current" "$old" | Out-Null
${restart}
Write-Output "rolled back to $old"
`
}

/**
 * Build a deploy job plan without touching the network.
 * @param {object} plan deployment plan.
 * @returns {object} plan summary.
 */
export function describePlan(plan) {
  return {
    target: {
      host: plan.host,
      user: plan.user ?? null,
      port: plan.port,
      os: plan.os,
      appRoot: plan.appRoot,
      sudo: plan.sudo,
    },
    release: plan.release,
    package: plan.package,
    services: plan.services,
    scope: plan.scope,
    steps: [
      `upload ${path.basename(plan.package.path)} to ${plan.remotePackage}`,
      `extract and prepare ${plan.releases}/${plan.release} (no service switch)`,
      `update shared config and service definitions for ${plan.appRoot}/current`,
      `switch ${plan.current} to ${plan.release}`,
      ...plan.services
        .filter(service => plan.scope === 'all' || service.role !== 'gate')
        .map(service => `restart ${service.name} (${service.role})`),
      `health check http://127.0.0.1:${plan.gatePort}/__gate/health`,
      `keep the newest ${plan.retention} releases (current/previous are never deleted)`,
      'on failure switch back to the previous release and restart',
    ],
  }
}

/**
 * SSH/SCP runner. Commands are executed directly (no local shell) so host
 * names and paths cannot be reinterpreted by a shell.
 */
export class SshRunner {
  /**
   * @param {object} plan deployment plan.
   * @param {{log?: (line: string) => void}} [options] options.
   */
  constructor(plan, options = {}) {
    this.plan = plan
    this.log = options.log ?? (() => {})
  }

  /** @returns {string[]} common SSH options. */
  sshOptions() {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', '-p', String(this.plan.port)]
    if (this.plan.identityFile) args.push('-i', this.plan.identityFile)
    return args
  }

  /** @returns {string} user@host. */
  target() {
    return this.plan.user ? `${this.plan.user}@${this.plan.host}` : this.plan.host
  }

  /**
   * Upload a local file with scp.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @returns {Promise<void>}
   */
  async upload(local, remote) {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(this.plan.port)]
    if (this.plan.identityFile) args.push('-i', this.plan.identityFile)
    args.push(local, `${this.target()}:${remote}`)
    await this.runProcess('scp', args)
  }

  /**
   * Run a local process and reject on a non-zero exit.
   * @param {string} command command.
   * @param {string[]} args arguments.
   * @param {string} [input] stdin.
   * @returns {Promise<{stdout:string,stderr:string}>} output.
   */
  runProcess(command, args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('exit', code => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim() || stdout.trim()}`))
      })
      if (input !== undefined) child.stdin.end(input)
      else child.stdin.end()
    })
  }

  /**
   * Run a script over SSH.
   * @param {string} script bash or PowerShell script.
   * @param {'linux'|'windows'} os target OS.
   * @returns {Promise<void>}
   */
  async script(script, os) {
    const base = this.sshOptions()
    if (os === 'linux') {
      const remote = this.plan.sudo ? 'sudo -n bash -s' : 'bash -s'
      await this.runProcess('ssh', [...base, this.target(), remote], script)
      return
    }
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    await this.runProcess('ssh', [...base, this.target(), `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`])
  }
}

/**
 * One deployment job store and runner.
 */
export class DeployManager {
  /**
   * @param {{repositoryRoot: string, dataDir: string, log?: (line:string)=>void, runnerFactory?: Function}} options options.
   */
  constructor(options) {
    this.repositoryRoot = options.repositoryRoot
    this.dataDir = options.dataDir
    this.logLine = options.log ?? (() => {})
    this.runnerFactory = options.runnerFactory ?? (plan => new SshRunner(plan, { log: line => this.logLine(line) }))
    /** @type {Map<string, Promise<object>>} */
    this.running = new Map()
  }

  /** @returns {Promise<void>} no owned process. */
  async dispose() {}

  /**
   * Detect the member's existing install root without changing anything.
   * @param {object} request SSH target.
   * @returns {Promise<{appRoot:string,serviceUser:string|undefined}>} detected install.
   */
  async inspectTarget(request) {
    return probeTarget({ ...request })
  }

  /**
   * Plan only; no network.
   * @param {object} request deploy options.
   * @returns {Promise<object>} plan summary.
   */
  async plan(request) {
    const plan = await buildDeployPlan({ ...request, repositoryRoot: this.repositoryRoot })
    return { ok: true, plan: describePlan(plan), scripts: request.includeScripts === true ? this.scripts(plan) : undefined }
  }

  /**
   * Produce all remote scripts for a plan.
   * @param {object} plan plan.
   * @returns {object} scripts.
   */
  scripts(plan) {
    if (plan.os === 'linux') {
      return {
        prepare: buildLinuxPrepareScript(plan),
        activate: buildLinuxActivateScript(plan),
        rollback: buildLinuxRollbackScript(plan),
      }
    }
    return {
      prepare: buildWindowsPrepareScript(plan),
      activate: buildWindowsActivateScript(plan),
      rollback: buildWindowsRollbackScript(plan),
    }
  }

  /**
   * Start a deployment or rollback job.
   * @param {object} request deploy options.
   * @returns {Promise<object>} job state.
   */
  async start(request) {
    const plan = await buildDeployPlan({ ...request, repositoryRoot: this.repositoryRoot })
    const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const dir = path.join(this.dataDir, id)
    await mkdir(dir, { recursive: true })
    const stateFile = path.join(dir, 'job.json')
    const logFile = path.join(dir, 'deploy.log')
    const state = {
      id,
      createdAt: new Date().toISOString(),
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: plan.release,
      package: plan.package.path,
      services: plan.services.map(service => service.name),
      status: 'running',
      phase: 'starting',
      error: null,
    }
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    const log = async line => {
      const stamp = new Date().toISOString()
      await writeFile(logFile, `[${stamp}] ${line}\n`, { encoding: 'utf8', flag: 'a' })
      this.logLine(line)
    }
    const task = this.#run(plan, state, stateFile, log)
    this.running.set(id, task)
    task.finally(() => this.running.delete(id)).catch(() => {})
    return { ok: true, job: state }
  }

  async #run(plan, state, stateFile, log) {
    try {
      const runner = this.runnerFactory(plan)
      await log(`target ${plan.host} (${plan.os}), release ${plan.release}`)
      await log(`package ${plan.package.path} (${plan.package.sha256.slice(0, 12)}…)`)
      await log(`uploading to ${plan.remotePackage}`)
      await runner.upload(plan.package.path, plan.remotePackage)
      const scripts = this.scripts(plan)
      state.phase = 'prepare'
      await this.#save(stateFile, state)
      await log('prepare: extract, shared dirs, service definitions (no switch)')
      await runner.script(scripts.prepare, plan.os)
      state.phase = 'activate'
      await this.#save(stateFile, state)
      await log('activate: switch current, restart services with the gateway last')
      await runner.script(scripts.activate, plan.os)
      state.status = 'succeeded'
      state.phase = 'done'
      await this.#save(stateFile, state)
      await log('deployment succeeded')
    } catch (error) {
      state.status = 'failed'
      state.phase = 'failed'
      state.error = error instanceof Error ? error.message : String(error)
      await this.#save(stateFile, state).catch(() => {})
      await log(`deployment failed: ${state.error}`).catch(() => {})
    }
  }

  async #save(stateFile, state) {
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /**
   * Read a job.
   * @param {string} id job id.
   * @returns {Promise<object|null>} state.
   */
  async status(id) {
    if (typeof id !== 'string' || !/^deploy-[A-Za-z0-9-]+$/.test(id)) return null
    try {
      return JSON.parse(await readFile(path.join(this.dataDir, id, 'job.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * Tail a job log.
   * @param {string} id job id.
   * @param {number} lines line count.
   * @returns {Promise<string>} log tail.
   */
  async logs(id, lines = 80) {
    if (typeof id !== 'string' || !/^deploy-[A-Za-z0-9-]+$/.test(id)) return ''
    try {
      const text = await readFile(path.join(this.dataDir, id, 'deploy.log'), 'utf8')
      return text.split('\n').slice(-Math.max(1, Math.min(lines, 500))).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Roll back to the previous release.
   * @param {object} request deploy options (target and appRoot are enough).
   * @returns {Promise<object>} job.
   */
  async rollback(request) {
    const plan = await buildDeployPlan({ ...request, repositoryRoot: this.repositoryRoot, skipPackage: true })
    const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const dir = path.join(this.dataDir, id)
    await mkdir(dir, { recursive: true })
    const stateFile = path.join(dir, 'job.json')
    const logFile = path.join(dir, 'deploy.log')
    const state = {
      id,
      createdAt: new Date().toISOString(),
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: 'rollback',
      status: 'running',
      phase: 'rollback',
      error: null,
    }
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    const log = async line => {
      const stamp = new Date().toISOString()
      await writeFile(logFile, `[${stamp}] ${line}\n`, { encoding: 'utf8', flag: 'a' })
      this.logLine(line)
    }
    const task = (async () => {
      try {
        const runner = this.runnerFactory(plan)
        await log('rolling back to the previous release')
        await runner.script(this.scripts(plan).rollback, plan.os)
        state.status = 'succeeded'
        state.phase = 'done'
      } catch (error) {
        state.status = 'failed'
        state.phase = 'failed'
        state.error = error instanceof Error ? error.message : String(error)
      }
      await this.#save(stateFile, state)
      await log(state.status === 'succeeded' ? 'rollback succeeded' : `rollback failed: ${state.error}`)
    })()
    this.running.set(id, task)
    task.finally(() => this.running.delete(id)).catch(() => {})
    return { ok: true, job: state }
  }
}
