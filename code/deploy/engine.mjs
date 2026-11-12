/**
 * Blue-green SSH deployment for dsh-mesh.
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
 * @module @local/dsh-mesh/deploy
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const DEFAULT_APP_ROOT = {
  linux: '/opt/dsh-mesh',
  windows: 'C:\\dsh-mesh',
}

/** Services used by the split package: DSH first, gateway last. */
const DEFAULT_SERVICES = {
  linux: [
    { name: 'dsh-web-app.service', role: 'dsh', command: 'start-dsh.sh' },
    { name: 'dsh-web-gate.service', role: 'gate', command: 'start.sh' },
  ],
  windows: [
    { name: 'DSH-Web-App', role: 'dsh', command: 'dsh-web-app-service.exe' },
    { name: 'DSH-Mesh', role: 'gate', command: 'dsh-mesh-service.exe' },
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

/** Escape a value for a .NET regex replacement string. */
function psReplacement(value) {
  return ps(String(value).replace(/\$/g, '$$$$'))
}

/** Escape a value for a sed replacement that uses `|` as its delimiter. */
function sedReplacement(value) {
  return String(value).replace(/[\\|&]/g, match => `\\${match}`)
}

/**
 * Wire the packaged dsh-mesh plugin into the DSH profile so the member's own
 * DSH loads the panel. Runs on the target with its bundled Node: it copies the
 * release plugin into the profile and appends the bundle, creating the profile
 * manifest when DSH has not booted on this member yet.
 *
 * Idempotent: a second deploy replaces the copy and keeps the bundle entry.
 */
export const PROFILE_WIRE_SCRIPT = `
import fs from 'node:fs'
import path from 'node:path'
const [profileDir, pluginDir] = process.argv.slice(2)
if (typeof profileDir !== 'string' || profileDir === '' || typeof pluginDir !== 'string' || pluginDir === '') {
  console.error('profile-wire: expected <profileDir> <pluginDir>')
  process.exit(2)
}
if (!fs.existsSync(pluginDir)) {
  console.log('profile-wire: the release has no plugins/dsh-mesh; profile left untouched')
  process.exit(0)
}
const manifestFile = path.join(profileDir, 'package.json')
let manifest = {
  name: 'dsh-profile-' + path.basename(profileDir),
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}
if (fs.existsSync(manifestFile)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch {
    console.error('profile-wire: ' + manifestFile + ' is not valid JSON; left untouched')
    process.exit(1)
  }
}
manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!bundles.includes('@local/dsh-mesh')) bundles.push('@local/dsh-mesh')
manifest.dsh.profile.bundles = bundles
manifest.dependencies['@local/dsh-mesh'] = 'link:./node_modules/@local/dsh-mesh'
const target = path.join(profileDir, 'node_modules', '@local', 'dsh-mesh')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.rmSync(target, { recursive: true, force: true })
fs.cpSync(pluginDir, target, { recursive: true })
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\\n')
console.log('profile-wire: dsh loads @local/dsh-mesh from ' + target)
`

/**
 * The deployer's DSH credentials file, or null when this host has no account.
 * @returns {string|null} absolute path.
 */
export function deployerCredentialsFile() {
  if (process.env.DSH_DEPLOY_SHARE_ACCOUNT === '0') return null
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
  const file = path.join(home, '.credentials.yaml')
  return existsSync(file) ? file : null
}

/** Human-readable byte count for progress details. */
export function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = bytes
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)} ${units[unit]}`
}

/** Add an actionable hint when SSH refused a changed host key. */
export function describeDeployFailure(message) {
  const text = String(message ?? '')
  if (!/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/iu.test(text)) return text
  return `${text}

SSH 主机密钥与 known_hosts 中的记录不一致：目标机可能重装过系统，或这个 VPN 地址已经属于另一台机器。请在 WireGuard 面板对该成员重新执行一次「SSH 授权」（生成命令时会同时刷新本机 known_hosts），或者手动执行 ssh-keygen -R <目标地址> 后重试。`
}

/** Deployment steps reported by the panel while a job runs. */
export function initialDeploySteps() {
  return [
    { key: 'upload', label: '上传安装包', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null },
    { key: 'prepare', label: '解压并准备新版本', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null },
    { key: 'activate', label: '切换并重启服务', status: 'pending', startedAt: null, finishedAt: null, detail: '', progress: null },
  ]
}

/** Encode a PowerShell script that copies stdin to one file (Windows upload). */
function windowsStdinWriter(remote) {
  const script = `$ErrorActionPreference = 'Stop'
$stdin = [Console]::OpenStandardInput()
$file = [IO.File]::Open(${ps(remote)}, [IO.FileMode]::Create)
try { $stdin.CopyTo($file) } finally { $file.Dispose() }`
  return Buffer.from(script, 'utf16le').toString('base64')
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
      : os === 'linux' ? 'start.sh' : 'dsh-mesh-service.exe'
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
  const prefix = `dsh-mesh-`
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
    // Copied from the deployer so every member shares one gateway password;
    // empty means "generate on the target".
    gatePassword: typeof options.gatePassword === 'string' ? options.gatePassword : '',
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
    // Named by content, not by release, so a retried deploy of the same package
    // reuses the upload instead of pushing hundreds of megabytes again.
    remotePackage: os === 'linux'
      ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}${path.extname(packagePath)}`
      : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}${path.extname(packagePath)}`,
    // The deployer's account grants travel with the deploy so a fresh member
    // needs no QR scan of its own.
    remoteCredentials: os === 'linux'
      ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}.account`
      : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}.account`,
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
      "$svc = Get-CimInstance Win32_Service -Filter \"Name='DSH-Mesh'\"",
      "$root = ''",
      'if ($svc -and $svc.PathName) {',
      '  if ($svc.PathName -match \'^"([^"]+)"\') { $exe = $matches[1] } else { $exe = ($svc.PathName -split \' \')[0] }',
      '  $root = Split-Path -Parent $exe',
      '}',
      'if (-not $root) { $root = Join-Path $env:USERPROFILE \'.dsh\\dsh-mesh\' }',
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
      : `C:\\Users\\${user ?? 'Public'}\\.dsh\\dsh-mesh`
    return { appRoot, serviceUser: undefined }
  }
  const script = `#!/usr/bin/env bash
set -u
root=''
runuser=''
for unit in dsh-web-gate.service dsh-web.service dsh-mesh.service; do
  if command -v systemctl >/dev/null 2>&1; then
    root=$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)
  fi
  if [ -n "$root" ]; then
    runuser=$(systemctl show "$unit" -p User --value 2>/dev/null || true)
    break
  fi
done
if [ -z "$root" ]; then
  root="$HOME/.dsh/dsh-mesh"
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
    ? `/home/${user}/.dsh/dsh-mesh`
    : '/root/.dsh/dsh-mesh'
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
# The gateway password belongs to the deployer: peer requests are signed with a
# secret derived from it, so members only need to share this password.
${plan.gatePassword ? `sed -i ${sh(`s|^DSH_GATE_PASSWORD=.*|DSH_GATE_PASSWORD=${sedReplacement(plan.gatePassword)}|`)} "$ENV_FILE"
grep -q '^DSH_GATE_PASSWORD=' "$ENV_FILE" || echo ${sh(`DSH_GATE_PASSWORD=${plan.gatePassword}`)} >> "$ENV_FILE"
echo 'gateway password synced from the deployer'
` : ''}sed -i '/^DSH_GATE_CLUSTER_KEY=/d' "$ENV_FILE"
test -x "$NEW/runtime/node/node"
"$NEW/runtime/node/node" --check "$NEW/gate/server.mjs"
"$NEW/runtime/node/node" - "$SHARED/home/profiles/web" "$NEW/plugins/dsh-mesh" <<'DSH_MESH_PROFILE_WIRE'
${PROFILE_WIRE_SCRIPT}
DSH_MESH_PROFILE_WIRE
# The deployer's account grants make this member signed in without a QR scan.
CREDENTIALS_FILE=${sh(plan.remoteCredentials)}
if [ -f "$CREDENTIALS_FILE" ]; then
  if "$NEW/runtime/node/node" "$NEW/shared/credentials-merge.mjs" "$SHARED/home/.credentials.yaml" "$CREDENTIALS_FILE"; then
    rm -f "$CREDENTIALS_FILE"
  else
    echo "could not copy the deployer account sign-in" >&2
  fi
fi
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
  const serviceLines = `function Ensure-DshService([string]$Name, [string]$Display, [string]$Description, [string]$ExePath) {
  $binPath = '"' + $ExePath + '"'
  if ($null -eq (Get-Service -Name $Name -ErrorAction SilentlyContinue)) {
    & sc.exe create $Name binPath= $binPath start= auto DisplayName= $Display | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc create failed for $Name" }
    & sc.exe description $Name $Description | Out-Null
    & sc.exe failure $Name reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    Write-Output "created service $Name"
  }
  & sc.exe config $Name binPath= $binPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc config failed for $Name" }
}
` + plan.services.map(service => {
    const command = service.command
    const display = service.role === 'dsh' ? 'DSH Web App' : 'DSH Mesh Gateway'
    const description = service.role === 'dsh' ? 'Independent DSH Web process' : 'DSH gateway, login and member proxy'
    const source = service.role === 'dsh' ? 'DshWebAppService.cs' : 'DshMeshService.cs'
    return `$exe = Join-Path $New ${ps(command)}
if (-not (Test-Path $exe)) {
  # The package ships the C# service sources, not the binaries, so compile the
  # wrapper into this release with the .NET Framework compiler.
  $serviceSource = Join-Path $New ${ps('code\\windows-service\\' + source)}
  if (-not (Test-Path $serviceSource)) { throw "missing service source: $serviceSource" }
  $csc = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
  if (-not (Test-Path $csc)) { throw 'cannot find csc.exe' }
  & $csc /nologo /target:exe /out:$exe /r:System.ServiceProcess.dll $serviceSource
  if ($LASTEXITCODE -ne 0) { throw "csc failed for $exe" }
}
Ensure-DshService ${ps(service.name)} ${ps(display)} ${ps(description)} ($AppRoot + '\\current\\' + ${ps(command)})`
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
${plan.preExtracted
  ? 'if (-not (Test-Path $New)) { throw "release directory missing: $New" }'
  : 'if (Test-Path $New) { throw "release already exists: $New" }'}
New-Item -ItemType Directory -Force -Path $New | Out-Null
${plan.preExtracted ? '' : 'Expand-Archive -LiteralPath $Package -DestinationPath $New -Force'}
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
if (-not (Test-Path $envFile)) {
  # First deploy of a fresh machine: create the gateway config that install.ps1
  # would have written, with random secrets, so the split services can start.
  $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $password = ${plan.gatePassword ? ps(plan.gatePassword) : '(-join (1..24 | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] }))'}
  $lines = @(
    '# DeepSeek Harness Web gateway (generated by the first deploy)',
    'DSH_GATE_PORT=${plan.gatePort}',
    'DSH_GATE_BIND=0.0.0.0',
    "DSH_GATE_PASSWORD=$password",
    'DSH_GATE_COOKIE_DAYS=30',
    'DSH_WEB_PORT=31280',
    'DSH_GATE_MEMBER_PORT=${plan.gatePort}',
    'DSH_TRUSTED_HOSTS='
  )
  [System.IO.File]::WriteAllText($envFile, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  Write-Output "generated $envFile (${plan.gatePassword ? 'gateway password copied from the deployer' : 'gateway password: $password'})"
  try {
    if (-not (Get-NetFirewallRule -DisplayName 'DSH Mesh ${plan.gatePort}' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName 'DSH Mesh ${plan.gatePort}' -Direction Inbound -Protocol TCP -LocalPort ${plan.gatePort} -Action Allow | Out-Null
    }
  } catch { Write-Warning "could not add the firewall rule: $($_.Exception.Message)" }
}
$text = Get-Content -LiteralPath $envFile -Raw
$text = [regex]::Replace($text, '(?m)^DSH_HOME=.*$', "DSH_HOME=$Shared\\home")
$text = [regex]::Replace($text, '(?m)^DSH_WORKDIR=.*$', "DSH_WORKDIR=$Shared\\workspace")
if ($text -notmatch '(?m)^DSH_HOME=') { $text += "\`r\`nDSH_HOME=$Shared\\home" }
if ($text -notmatch '(?m)^DSH_WORKDIR=') { $text += "\`r\`nDSH_WORKDIR=$Shared\\workspace" }
${plan.gatePassword ? `$text = [regex]::Replace($text, '(?m)^DSH_GATE_PASSWORD=.*$', ${psReplacement(`DSH_GATE_PASSWORD=${plan.gatePassword}`)})
if ($text -notmatch '(?m)^DSH_GATE_PASSWORD=') { $text += [Environment]::NewLine + ${ps(`DSH_GATE_PASSWORD=${plan.gatePassword}`)} }
Write-Output 'gateway password synced from the deployer'
` : ''}$text = [regex]::Replace($text, '(?m)^DSH_GATE_CLUSTER_KEY=.*\r?\n?', '')
Set-Content -LiteralPath $envFile -Value $text -Encoding utf8 -NoNewline
$node = Join-Path $New 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { throw "missing $node" }
& $node --check (Join-Path $New 'gate\\server.mjs')
if ($LASTEXITCODE -ne 0) { throw 'gate syntax check failed' }
$wireScript = Join-Path $env:TEMP 'dsh-mesh-profile-wire.mjs'
[IO.File]::WriteAllText($wireScript, ${ps(PROFILE_WIRE_SCRIPT)}, [Text.UTF8Encoding]::new($false))
& $node $wireScript (Join-Path $Shared 'home\\profiles\\web') (Join-Path $New 'plugins\\dsh-mesh')
if ($LASTEXITCODE -ne 0) { throw 'could not wire the dsh-mesh plugin into the DSH profile' }
Remove-Item $wireScript -Force -ErrorAction SilentlyContinue
$credentialsFile = '${plan.remoteCredentials}'
if (Test-Path $credentialsFile) {
  & $node (Join-Path $New 'shared\\credentials-merge.mjs') (Join-Path $Shared 'home\\.credentials.yaml') $credentialsFile
  if ($LASTEXITCODE -eq 0) { Remove-Item $credentialsFile -Force -ErrorAction SilentlyContinue } else { Write-Warning 'could not copy the deployer account sign-in' }
}
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
   * Upload a local file and report byte progress.
   *
   * The file is streamed through the SSH connection when the target can accept
   * stdin (POSIX `cat` or a PowerShell stdin writer). scp stays as a fallback
   * when streaming fails, so an exotic target still deploys even without a
   * progress meter.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @param {(progress: {bytes:number,totalBytes:number,percent:number,speed:number,indeterminate?:boolean}) => void} [onProgress] progress callback.
   * @returns {Promise<void>}
   */
  async upload(local, remote, onProgress) {
    const totalBytes = (await stat(local)).size
    try {
      await this.#uploadStream(local, remote, totalBytes, onProgress)
    } catch (error) {
      this.log(`streamed upload failed (${error instanceof Error ? error.message : String(error)}); retrying with scp`)
      onProgress?.({ bytes: 0, totalBytes, percent: 0, speed: 0, indeterminate: true })
      const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(this.plan.port)]
      if (this.plan.identityFile) args.push('-i', this.plan.identityFile)
      args.push(local, `${this.target()}:${remote}`)
      await this.runProcess('scp', args)
      onProgress?.({ bytes: totalBytes, totalBytes, percent: 100, speed: 0, indeterminate: false })
    }
  }

  /**
   * Count the entries in a remote archive.
   * @param {string} remote remote archive path.
   * @returns {Promise<number>} entry count.
   */
  async archiveEntries(remote) {
    const { stdout } = await this.runProcess('ssh', [...this.sshOptions(), this.target(), `tar -tf "${remote}"`])
    return String(stdout).split(/\r?\n/u).filter(line => line.trim() !== '').length
  }

  /**
   * Extract a remote archive with the tar that ships with Windows, reporting
   * one callback per extracted entry.
   * @param {string} remote remote archive path.
   * @param {string} target remote directory.
   * @param {() => void} [onEntry] called for every extracted entry.
   * @returns {Promise<void>}
   */
  async extractArchive(remote, target, onEntry) {
    await this.runProcess('ssh', [...this.sshOptions(), this.target(), `cmd /c if not exist "${target}" mkdir "${target}"`])
    await this.runProcess('ssh', [...this.sshOptions(), this.target(), `tar -xf "${remote}" -C "${target}" -v`], undefined, onEntry, { countOnly: true })
  }

  /**
   * Read a remote file's size, or null when it cannot be read.
   * @param {string} remote remote path.
   * @returns {Promise<number|null>} size in bytes.
   */
  async remoteSize(remote) {
    try {
      const args = [...this.sshOptions(), this.target()]
      let command
      if (this.plan.os === 'windows') {
        const encoded = Buffer.from(`(Get-Item -LiteralPath ${ps(remote)}).Length`, 'utf16le').toString('base64')
        command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
      } else {
        command = `stat -c %s -- ${sh(remote)}`
      }
      const { stdout } = await this.runProcess('ssh', [...args, command])
      const size = Number.parseInt(String(stdout).trim(), 10)
      return Number.isSafeInteger(size) ? size : null
    } catch {
      return null
    }
  }

  /**
   * Stream one file to the remote path through `ssh` stdin.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @param {number} totalBytes file size.
   * @param {Function} [onProgress] progress callback.
   * @returns {Promise<void>}
   */
  async #uploadStream(local, remote, totalBytes, onProgress) {
    // PowerShell cannot drain a piped stdin reliably over Windows OpenSSH (it
    // blocks after a few hundred KiB), so Windows uses the tar that ships with
    // Windows 10+ as the remote writer: `tar -xf -` reads the archive from
    // stdin and writes the exact file bytes.
    const windows = this.plan.os === 'windows'
    const remoteCommand = windows
      ? `tar -xf - -C "${path.win32.dirname(remote)}"`
      : `cat > ${sh(remote)}`
    const args = [...this.sshOptions(), this.target(), remoteCommand]
    // tar extracts under the archive's own entry name, so stage a hard link
    // named like the remote file instead of the local package name.
    let tarDir = null
    let tarName = null
    if (windows) {
      tarName = path.win32.basename(remote)
      tarDir = await mkdtemp(path.join(tmpdir(), 'dsh-mesh-upload-'))
      const staged = path.join(tarDir, tarName)
      try {
        try {
          await link(local, staged)
        } catch {
          await copyFile(local, staged)
        }
      } catch (error) {
        await rm(tarDir, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }
    return new Promise((resolve, reject) => {
      const ssh = spawn('ssh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const tar = windows
        ? spawn('tar', ['-cf', '-', '-C', tarDir, tarName], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : null
      const source = tar !== null ? tar.stdout : createReadStream(local)
      let sent = 0
      let stderr = ''
      let settled = false
      let lastAt = Date.now()
      let lastBytes = 0
      let lastDataAt = Date.now()
      let speed = 0
      const finish = error => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        source.destroy()
        tar?.kill('SIGKILL')
        ssh.kill('SIGKILL')
        if (tarDir !== null) void rm(tarDir, { recursive: true, force: true }).catch(() => {})
        if (error) reject(error)
        else resolve()
      }
      // A remote that stops reading leaves the pipe full and the socket idle;
      // fail instead of waiting forever.
      const watchdog = setInterval(() => {
        if (Date.now() - lastDataAt > 30_000) {
          finish(new Error('upload stalled: the remote stopped reading stdin (30s without progress)'))
        }
      }, 5_000)
      watchdog.unref?.()
      const report = (force = false) => {
        const now = Date.now()
        if (!force && now - lastAt < 200) return
        const seconds = Math.max(1, now - lastAt) / 1000
        speed = Math.max(0, (sent - lastBytes) / seconds)
        lastAt = now
        lastBytes = sent
        const percent = totalBytes > 0
          ? Math.min(windows ? 99 : 100, Math.round((sent / totalBytes) * 100))
          : 0
        onProgress?.({ bytes: sent, totalBytes, percent, speed, indeterminate: false })
      }
      source.on('data', chunk => {
        sent += chunk.length
        lastDataAt = Date.now()
        report()
      })
      source.once('error', error => finish(error))
      ssh.stdout.resume()
      ssh.stderr.on('data', chunk => { stderr += String(chunk) })
      ssh.once('error', error => finish(error))
      ssh.once('exit', code => {
        if (code === 0) {
          report(true)
          finish()
        } else {
          finish(new Error(`ssh upload exited with ${String(code)}: ${stderr.trim()}`))
        }
      })
      ssh.stdin.once('error', () => {})
      if (tar !== null) {
        let tarError = ''
        tar.stderr.on('data', chunk => { tarError += String(chunk) })
        tar.once('error', error => finish(error))
        tar.once('exit', code => {
          if (code !== 0) finish(new Error(`local tar exited with ${String(code)}: ${tarError.trim()}`))
        })
      }
      source.pipe(ssh.stdin)
    })
  }

  /**
   * Run a local process and reject on a non-zero exit.
   * @param {string} command command.
   * @param {string[]} args arguments.
   * @param {string} [input] stdin.
   * @returns {Promise<{stdout:string,stderr:string}>} output.
   */
  runProcess(command, args, input, onLine, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const buffers = { out: '', err: '' }
      const emit = (key, chunk) => {
        const text = buffers[key] + String(chunk)
        const lines = text.split(/\r?\n/u)
        buffers[key] = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed !== '') onLine?.(options.countOnly === true ? '' : trimmed)
        }
      }
      const flush = () => {
        for (const key of ['out', 'err']) {
          const trimmed = buffers[key].trim()
          if (trimmed !== '') onLine?.(trimmed)
          buffers[key] = ''
        }
      }
      child.stdout.on('data', chunk => {
        stdout += String(chunk)
        emit('out', chunk)
      })
      child.stderr.on('data', chunk => {
        stderr += String(chunk)
        emit('err', chunk)
      })
      child.once('error', reject)
      child.once('exit', code => {
        flush()
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
  async script(script, os, onLine) {
    const base = this.sshOptions()
    if (os === 'linux') {
      const remote = this.plan.sudo ? 'sudo -n bash -s' : 'bash -s'
      await this.runProcess('ssh', [...base, this.target(), remote], script, onLine)
      return
    }
    // -EncodedCommand is UTF-16LE base64 (2.7x the source) and cmd.exe rejects
    // command lines over 8191 characters, which the prepare script exceeds.
    // Ship it as a temp .ps1 and run it with -File instead.
    const name = `dsh-deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.ps1`
    const remotePath = `C:\\Windows\\Temp\\${name}`
    const localPath = path.join(tmpdir(), name)
    await writeFile(localPath, `\uFEFF${script}`, 'utf8')
    try {
      await this.upload(localPath, remotePath)
      await this.runProcess(
        'ssh',
        [...base, this.target(), `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remotePath}"`],
        undefined,
        onLine,
      )
    } finally {
      await rm(localPath, { force: true }).catch(() => {})
      await this.runProcess('ssh', [...base, this.target(), `cmd /c del /f "${remotePath}"`]).catch(() => {})
    }
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
    /** @type {Map<string, object>} live job state, so progress reads skip the disk */
    this.states = new Map()
    /** @type {Map<string, number>} last progress flush per job */
    this.saves = new Map()
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
    const plan = await buildDeployPlan({
      ...request,
      gatePassword: typeof request.gatePassword === 'string' ? request.gatePassword : process.env.DSH_GATE_PASSWORD,
      repositoryRoot: this.repositoryRoot,
    })
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
    const plan = await buildDeployPlan({
      ...request,
      gatePassword: typeof request.gatePassword === 'string' ? request.gatePassword : process.env.DSH_GATE_PASSWORD,
      repositoryRoot: this.repositoryRoot,
    })
    const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const dir = path.join(this.dataDir, id)
    await mkdir(dir, { recursive: true })
    const stateFile = path.join(dir, 'job.json')
    const logFile = path.join(dir, 'deploy.log')
    const state = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      member: typeof request.member === 'string' && request.member !== '' ? request.member : null,
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: plan.release,
      package: plan.package.path,
      services: plan.services.map(service => service.name),
      status: 'running',
      phase: 'starting',
      error: null,
      steps: initialDeploySteps(),
      progress: { bytes: 0, totalBytes: plan.package.bytes, percent: 0, speed: 0, indeterminate: false },
    }
    if (this.states.size >= 100) {
      const oldest = this.states.keys().next()
      if (!oldest.done) this.states.delete(oldest.value)
    }
    this.states.set(id, state)
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
    const stamp = () => new Date().toISOString()
    const stepOf = key => state.steps.find(item => item.key === key)
    const mark = async (key, status, detail) => {
      const step = stepOf(key)
      if (step !== undefined) {
        step.status = status
        if (status === 'running' && step.startedAt === null) step.startedAt = stamp()
        if (status === 'succeeded' || status === 'failed') step.finishedAt = stamp()
        if (typeof detail === 'string' && detail !== '') step.detail = detail
      }
      state.updatedAt = stamp()
      await this.#save(stateFile, state)
    }
    const note = (key, text) => {
      const step = stepOf(key)
      if (step !== undefined) step.detail = text
      state.updatedAt = stamp()
      void log(text).catch(() => {})
    }
    try {
      const runner = this.runnerFactory(plan)
      await log(`target ${plan.host} (${plan.os}), release ${plan.release}`)
      await log(`package ${plan.package.path} (${plan.package.sha256.slice(0, 12)}…)`)
      await log(`uploading to ${plan.remotePackage}`)
      await mark('upload', 'running')
      const uploadStarted = Date.now()
      const existingBytes = typeof runner.remoteSize === 'function'
        ? await runner.remoteSize(plan.remotePackage).catch(() => null)
        : null
      if (existingBytes === plan.package.bytes) {
        await log(`package already present on the target (${formatBytes(existingBytes)}), skipping upload`)
        state.progress = { bytes: existingBytes, totalBytes: plan.package.bytes, percent: 100, speed: 0, indeterminate: false }
        await mark('upload', 'succeeded', `${formatBytes(existingBytes)} · 已存在，跳过上传`)
      } else {
        await runner.upload(plan.package.path, plan.remotePackage, progress => {
          const totalBytes = progress.totalBytes ?? plan.package.bytes
          state.progress = {
            bytes: progress.bytes ?? 0,
            totalBytes,
            percent: progress.percent ?? (totalBytes > 0 ? Math.min(100, Math.round(((progress.bytes ?? 0) / totalBytes) * 100)) : 0),
            speed: progress.speed ?? 0,
            indeterminate: progress.indeterminate === true,
          }
          state.updatedAt = stamp()
          this.#saveThrottled(stateFile, state)
        })
        const uploadSeconds = Math.max(0.1, (Date.now() - uploadStarted) / 1000)
        state.progress = {
          bytes: plan.package.bytes,
          totalBytes: plan.package.bytes,
          percent: 100,
          speed: plan.package.bytes / uploadSeconds,
          indeterminate: false,
        }
        await mark('upload', 'succeeded', `${formatBytes(plan.package.bytes)} · ${uploadSeconds.toFixed(1)}s · ${formatBytes(plan.package.bytes / uploadSeconds)}/s`)
      }
      // Sign the member in with the deployer's account: the account grants in
      // `.credentials.yaml` are all a member needs, so no QR scan is required.
      const credentialsFile = deployerCredentialsFile()
      if (credentialsFile !== null) {
        try {
          await runner.upload(credentialsFile, plan.remoteCredentials)
          await log('shared the deployer\'s account sign-in')
        } catch (error) {
          await log(`account sign-in was not shared: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        await log('no deployer account to share (DSH_HOME/.credentials.yaml is missing)')
      }
      state.phase = 'prepare'
      await mark('prepare', 'running')
      await log('prepare: extract, shared dirs, service definitions (no switch)')
      // Expand-Archive needs minutes for a 78k-entry package; Windows tar does
      // it in under a minute and reports one line per extracted entry.
      let preExtracted = false
      if (plan.os === 'windows' && typeof runner.archiveEntries === 'function' && typeof runner.extractArchive === 'function') {
        const newDir = `${plan.releases}\\${plan.release}`
        const total = await runner.archiveEntries(plan.remotePackage).catch(() => 0)
        if (total > 0) {
          await log(`extracting ${total} archive entries with tar`)
          const prepareStep = state.steps.find(item => item.key === 'prepare')
          let done = 0
          await runner.extractArchive(plan.remotePackage, newDir, () => {
            done += 1
            if (done % 500 === 0 || done === total) {
              if (prepareStep !== undefined) {
                prepareStep.progress = { done, total, percent: Math.min(99, Math.round((done / total) * 100)) }
              }
              state.updatedAt = stamp()
              this.#saveThrottled(stateFile, state)
            }
          })
          if (prepareStep !== undefined) prepareStep.progress = { done: total, total, percent: 100 }
          preExtracted = true
        }
      }
      const scripts = this.scripts({ ...plan, preExtracted })
      await runner.script(scripts.prepare, plan.os, line => note('prepare', line))
      await mark('prepare', 'succeeded')
      state.phase = 'activate'
      await mark('activate', 'running')
      await log('activate: switch current, restart services with the gateway last')
      await runner.script(scripts.activate, plan.os, line => note('activate', line))
      await mark('activate', 'succeeded')
      state.status = 'succeeded'
      state.phase = 'done'
      state.updatedAt = stamp()
      await this.#save(stateFile, state)
      await log('deployment succeeded')
    } catch (error) {
      state.status = 'failed'
      state.phase = 'failed'
      state.error = describeDeployFailure(error instanceof Error ? error.message : String(error))
      state.updatedAt = stamp()
      const active = state.steps.find(item => item.status === 'running')
      if (active !== undefined) {
        active.status = 'failed'
        active.finishedAt = stamp()
      }
      await this.#save(stateFile, state).catch(() => {})
      await log(`deployment failed: ${state.error}`).catch(() => {})
    } finally {
      this.running.delete(state.id)
    }
  }

  /**
   * Persist upload progress at most a few times per second.
   * @param {string} stateFile job state file.
   * @param {object} state job state.
   * @returns {void}
   */
  #saveThrottled(stateFile, state) {
    const now = Date.now()
    if (now - (this.saves.get(state.id) ?? 0) < 300) return
    this.saves.set(state.id, now)
    void this.#save(stateFile, state).catch(() => {})
  }

  async #save(stateFile, state) {
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  /**
   * Wait for one running deployment or rollback job to settle.
   * @param {string} id job id.
   * @returns {Promise<object|null>} final job state.
   */
  async wait(id) {
    const running = this.running.get(id)
    if (running !== undefined) await running
    return this.status(id)
  }

  /**
   * Read a job.
   * @param {string} id job id.
   * @returns {Promise<object|null>} state.
   */
  async status(id) {
    if (typeof id !== 'string' || !/^deploy-[A-Za-z0-9-]+$/.test(id)) return null
    const live = this.states.get(id)
    if (live !== undefined) return live
    try {
      return JSON.parse(await readFile(path.join(this.dataDir, id, 'job.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * List recent deployment jobs, newest first.
   * @param {number} [limit] maximum number of jobs.
   * @returns {Promise<object[]>} jobs.
   */
  async list(limit = 20) {
    const jobs = []
    let entries = []
    try {
      entries = await readdir(this.dataDir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('deploy-')) continue
      try {
        jobs.push(JSON.parse(await readFile(path.join(this.dataDir, entry.name, 'job.json'), 'utf8')))
      } catch {
        // A job directory without a readable state is not worth reporting.
      }
    }
    for (const [id, live] of this.states) {
      if (!jobs.some(job => job.id === id)) jobs.push(live)
    }
    jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    return jobs.slice(0, Math.max(1, Math.min(limit, 100)))
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
        state.error = describeDeployFailure(error instanceof Error ? error.message : String(error))
      }
      await this.#save(stateFile, state)
      await log(state.status === 'succeeded' ? 'rollback succeeded' : `rollback failed: ${state.error}`)
    })()
    this.running.set(id, task)
    task.finally(() => this.running.delete(id)).catch(() => {})
    return { ok: true, job: state }
  }
}
