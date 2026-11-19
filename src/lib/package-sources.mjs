/**
 * Package-source helpers for the upgrade dialog.
 *
 * Two sources are added next to the gateway's `~/.dsh/packages`:
 *
 * - the latest release (`latest` tag on GitHub/Gitee), and
 * - an archive that already exists on the target member.
 *
 * The release manifest is public and small; the archive is not. This module
 * keeps the parsing and path rules pure so the service and the tests agree on
 * what a "valid target package" is.
 *
 * @module @local/dsh-mesh/package-sources
 */

import path from 'node:path'

/** Archive names the deploy engine and the release publisher both produce. */
export const PACKAGE_ARCHIVE_RE = /^dsh-mesh-(.+)-(\d{8}[A-Z]+)-(linux|win(?:dows)?)-(x64|arm64)\.(tar\.gz|tgz|zip)$/u

/** Release asset keys the publisher uses. */
export const RELEASE_TARGET_RE = /^(linux|win)-(x64|arm64)$/u

/**
 * Parse version, build stamp, OS and architecture out of an archive name.
 * @param {string} name archive file name.
 * @returns {{version: string, buildStamp: string, os: 'linux'|'windows', arch: 'x64'|'arm64', target: string}|null} parsed name.
 */
export function packageTargetFromName(name) {
  const match = PACKAGE_ARCHIVE_RE.exec(String(name ?? ''))
  if (match === null) return null
  const os = match[3].startsWith('win') ? 'windows' : 'linux'
  const arch = match[4]
  return {
    version: match[1],
    buildStamp: match[2],
    os,
    arch,
    target: `${os === 'windows' ? 'win' : 'linux'}-${arch}`,
  }
}

/**
 * One normalized release asset.
 * @typedef {{target: string, os: 'linux'|'windows', arch: 'x64'|'arm64', name: string, bytes: number, sha256: string, providers: Array<'github'|'gitee'>}} ReleaseAsset
 */

/**
 * Normalize a `latest.json` document into the shape the panel consumes.
 *
 * Invalid entries are dropped rather than failing the whole catalog: one bad
 * target must not hide the platform that is actually deployable.
 * @param {object} manifest parsed `latest.json`.
 * @param {{provider?: string, manifestUrls?: string[]}} [options] provenance.
 * @returns {{ok: boolean, configured: boolean, provider: string|null, version: string|null, buildStamp: string|null, publishedAt: string|null, assets: ReleaseAsset[], manifestUrls: string[], error?: string}} result.
 */
export function normalizeLatestManifest(manifest, options = {}) {
  const assets = []
  const entries = manifest?.assets !== null && typeof manifest?.assets === 'object' ? manifest.assets : {}
  for (const [target, entry] of Object.entries(entries)) {
    if (!RELEASE_TARGET_RE.test(target)) continue
    if (entry === null || typeof entry !== 'object') continue
    const name = typeof entry.archive === 'string' ? entry.archive.trim() : ''
    const parsed = packageTargetFromName(name)
    if (parsed === null || parsed.target !== target) continue
    const bytes = Number(entry.bytes)
    if (!Number.isSafeInteger(bytes) || bytes <= 0) continue
    const sha256 = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : ''
    if (!/^[a-f0-9]{64}$/u.test(sha256)) continue
    const providers = []
    if (typeof entry.github?.url === 'string' && entry.github.url !== '') providers.push('github')
    if (Array.isArray(entry.gitee?.parts) && entry.gitee.parts.length > 0
      && Array.isArray(entry.gitee?.urls) && entry.gitee.urls.length > 0) providers.push('gitee')
    assets.push({ target, os: parsed.os, arch: parsed.arch, name, bytes, sha256, providers })
  }
  assets.sort((left, right) => left.target.localeCompare(right.target))
  return {
    ok: assets.length > 0,
    configured: true,
    provider: typeof options.provider === 'string' && options.provider !== '' ? options.provider : null,
    version: typeof manifest?.version === 'string' ? manifest.version : null,
    buildStamp: typeof manifest?.buildStamp === 'string' ? manifest.buildStamp : null,
    publishedAt: typeof manifest?.publishedAt === 'string' ? manifest.publishedAt : null,
    assets,
    manifestUrls: Array.isArray(options.manifestUrls) ? options.manifestUrls.filter(url => typeof url === 'string') : [],
    ...(assets.length === 0 ? { error: '发布清单里没有可用的部署包' } : {}),
  }
}

/**
 * Pick the asset for one target key. `windows-*` is accepted as an alias for
 * `win-*` so a caller that derives the key from `os.platform()` still works.
 * @param {{assets?: ReleaseAsset[]}} release normalized release.
 * @param {string} target target key or empty.
 * @returns {ReleaseAsset|null} asset.
 */
export function selectLatestAsset(release, target) {
  const wanted = normalizeTarget(target)
  if (wanted === '') return null
  const assets = Array.isArray(release?.assets) ? release.assets : []
  return assets.find(asset => asset.target === wanted) ?? null
}

/**
 * Normalize a target key: `windows-x64` and `win32-x64` become `win-x64`.
 * @param {string} value target key.
 * @returns {string} normalized key or ''.
 */
export function normalizeTarget(value) {
  const text = String(value ?? '').trim().toLowerCase()
  const match = /^(linux|win(?:dows)?|win32)-(x64|arm64)$/u.exec(text)
  if (match === null) return ''
  return `${match[1].startsWith('linux') ? 'linux' : 'win'}-${match[2]}`
}

/**
 * Candidate roots on a member that hold dsh-mesh archives.
 * @param {string} home member home.
 * @param {'linux'|'windows'} os member OS.
 * @returns {string[]} absolute roots.
 */
export function packageRoots(home, os) {
  const base = String(home ?? '').replace(/[\\/]+$/u, '')
  if (base === '') return []
  const join = os === 'windows' ? path.win32.join : path.posix.join
  return [join(base, '.dsh', 'packages'), join(base, '.dsh', 'mesh', 'upgrade')]
}

/**
 * Whether a path is one of the archives a member is allowed to offer.
 * @param {string} candidate absolute archive path.
 * @param {string} home member home.
 * @param {'linux'|'windows'} os member OS.
 * @returns {boolean} allowed.
 */
export function isAllowedPackagePath(candidate, home, os) {
  const text = String(candidate ?? '').trim()
  if (text === '') return false
  const p = os === 'windows' ? path.win32 : path.posix
  const normalized = p.normalize(text)
  if (packageTargetFromName(p.basename(normalized)) === null) return false
  const roots = packageRoots(home, os).map(root => p.normalize(root))
  const comparand = os === 'windows' ? normalized.toLowerCase() : normalized
  return roots.some((root) => {
    const prefix = os === 'windows' ? root.toLowerCase() : root
    return comparand === prefix || comparand.startsWith(`${prefix}${p.sep}`)
  })
}

/**
 * Parse the line protocol printed by {@link listPackagesScript}.
 *
 * One line per archive: `path<TAB>bytes<TAB>mtime<TAB>sha256`. The digest may
 * be empty when there is no `.sha256` sidecar; the upgrade request computes it
 * before starting the job.
 * @param {string} stdout command output.
 * @returns {Array<{name: string, path: string, bytes: number, mtime: string, sha256: string|null, target: string, os: 'linux'|'windows', arch: 'x64'|'arm64'}>} packages.
 */
export function parseTargetPackageList(stdout) {
  const packages = []
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const text = line.trim()
    if (text === '') continue
    const [file, rawBytes, rawMtime, rawSha] = text.split('\t')
    if (file === undefined || rawBytes === undefined) continue
    const parsed = packageTargetFromName(file.split(/[\\/]/u).pop() ?? '')
    if (parsed === null) continue
    const bytes = Number(rawBytes)
    if (!Number.isSafeInteger(bytes) || bytes <= 0) continue
    const sha256 = typeof rawSha === 'string' && /^[a-f0-9]{64}$/u.test(rawSha.trim()) ? rawSha.trim().toLowerCase() : null
    const mtime = normalizeMtime(rawMtime)
    packages.push({ name: file.split(/[\\/]/u).pop() ?? file, path: file, bytes, mtime, sha256, ...parsed })
  }
  packages.sort((left, right) => right.mtime.localeCompare(left.mtime))
  return packages
}

/**
 * Normalize a Linux epoch-seconds or Windows ISO timestamp to ISO-8601.
 * @param {string} value raw timestamp.
 * @returns {string} ISO timestamp, or ''.
 */
function normalizeMtime(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  if (/^\d+$/u.test(text)) {
    const seconds = Number.parseInt(text, 10)
    return Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : ''
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

/**
 * The shell / PowerShell program that lists an archive on a member.
 *
 * It deliberately prints a tiny line protocol instead of JSON: the same parser
 * works over SSH on Linux and Windows, and a path containing spaces survives
 * because the separator is a tab. `home` is the home the member's service
 * reported, which may differ from the SSH user's `$HOME`; passing it keeps the
 * list and the path allow-list looking at the same directory.
 * @param {'linux'|'windows'} os member OS.
 * @param {string} [home] member home reported by its service.
 * @returns {string} script.
 */
export function listPackagesScript(os, home = '') {
  const homeDir = String(home ?? '').trim()
  if (os === 'windows') {
    const base = homeDir === '' ? '$env:USERPROFILE' : powershellQuote(homeDir)
    return `$ErrorActionPreference = 'SilentlyContinue'
$base = ${base}
$roots = @(
  (Join-Path $base '.dsh\\packages'),
  (Join-Path $base '.dsh\\mesh\\upgrade')
)
$rows = @()
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Name -match '^dsh-mesh-.*\\.(zip|tar\\.gz|tgz)$' } | ForEach-Object {
    $sha = ''
    $side = "$($_.FullName).sha256"
    if (Test-Path -LiteralPath $side) {
      $first = Get-Content -LiteralPath $side -TotalCount 1
      if ($first) { $sha = ($first -split '\\s+')[0] }
    }
    $rows += ($_.FullName + [char]9 + $_.Length + [char]9 + $_.LastWriteTimeUtc.ToString('o') + [char]9 + $sha)
  }
}
$rows | ForEach-Object { Write-Output $_ }
`
  }
  const base = homeDir === '' ? '"$HOME"' : shellQuote(homeDir)
  return `BASE=${base}
for root in "$BASE/.dsh/packages" "$BASE/.dsh/mesh/upgrade"; do
  [ -d "$root" ] || continue
  find "$root" -maxdepth 3 -type f \\( -name 'dsh-mesh-*.tar.gz' -o -name 'dsh-mesh-*.tgz' -o -name 'dsh-mesh-*.zip' \\) -print0 2>/dev/null |
  while IFS= read -r -d '' file; do
    bytes=$(stat -c %s -- "$file" 2>/dev/null || echo 0)
    mtime=$(stat -c %Y -- "$file" 2>/dev/null || echo 0)
    sha=''
    side="$file.sha256"
    if [ -f "$side" ]; then sha=$(sed -n '1s/[[:space:]].*//p' "$side" 2>/dev/null || true); fi
    printf '%s\\t%s\\t%s\\t%s\\n' "$file" "$bytes" "$mtime" "$sha"
  done
done
`
}

/**
 * Quote a value for a POSIX shell command line.
 * @param {string} value value.
 * @returns {string} single-quoted value.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`
}

/**
 * Quote a value for a PowerShell single-quoted string.
 * @param {string} value value.
 * @returns {string} quoted value.
 */
export function powershellQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}
