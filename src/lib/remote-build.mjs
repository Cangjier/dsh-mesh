/**
 * Build on a member instead of on the gateway.
 *
 * The panel's 编译 button has two jobs: keep the deterministic engine as the
 * only thing that produces a package, and let the machine with the best
 * internet access do the downloading. A member build therefore
 *
 *   1. updates a dsh-mesh checkout on the member (git fetch + reset --hard),
 *   2. runs the same `code/build/cli.mjs build` a human would run, streaming
 *      its output into the gateway's job log,
 *   3. reads the member-side `state.json` for the real outcome, and
 *   4. copies the finished archives into `~/.dsh/packages` on the gateway,
 *      which is what the deploy panel already lists.
 *
 * Nothing is decided by parsing the log: the log is only there to show
 * progress. The member's state file is the source of truth.
 *
 * @module @local/dsh-mesh/remote-build
 */

import { createHash } from 'node:crypto'
import { open, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appendLog, readState, updateState } from '../../code/build/job.mjs'
import { phaseFromLine } from '../../code/build/progress.mjs'
import { SshRunner } from '../../code/deploy/engine.mjs'

/** Repository the member builds from. */
export const DEFAULT_MESH_REPO = 'https://github.com/Cangjier/dsh-mesh.git'

/** Where the member keeps its checkout and its build jobs. */
const REMOTE_SRC = '$HOME/.dsh/mesh/build-src'
const REMOTE_JOBS = '$HOME/.dsh/mesh/build'
const REMOTE_BIN = '$HOME/.dsh/mesh/bin'
const REMOTE_NODE_DIR = '$HOME/.dsh/dsh-mesh/current/runtime/node/bin'

// The line→progress mapping is shared with the local engine so a remote job
// and a local one show the same target-aware numbers.
export { phaseFromLine }

/**
 * Build the bash script that runs one job on a member.
 *
 * The member's checkout is kept up to date by hard resetting to `origin/main`:
 * a build must reflect what is on main, not whatever a previous run left in
 * the tree. A local checkout that is behind main would otherwise silently
 * build old overlays.
 * @param {{jobId: string, ref: string, targets: string[], buildStamp?: string, proxyUrl?: string|null, repoUrl?: string, heapMb?: number}} options script input.
 * @returns {string} bash script.
 */
export function remoteBuildScript(options) {
  const ref = String(options.ref)
  const targets = options.targets.join(',')
  const out = `${REMOTE_JOBS}/${options.jobId}`
  const heap = Number.isSafeInteger(options.heapMb) && options.heapMb > 0 ? options.heapMb : 2048
  // One full build (source + node_modules + one package tree + archive) takes
  // several GiB; a second target adds another package tree. Checking before
  // the download turns a mid-run ENOSPC into an immediate, readable failure.
  const needGiB = 5 + 3 * options.targets.length
  const lines = [
    'set -u',
    `export PATH="${REMOTE_BIN}:${REMOTE_NODE_DIR}:$PATH"`,
    'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    'export CI=1',
    `export NODE_OPTIONS="--max-old-space-size=${String(heap)}"`,
    options.proxyUrl ? `export HTTP_PROXY=${quote(options.proxyUrl)} HTTPS_PROXY=${quote(options.proxyUrl)} npm_config_proxy=${quote(options.proxyUrl)} npm_config_https_proxy=${quote(options.proxyUrl)}` : '',
    `mkdir -p ${REMOTE_BIN} ${out}`,
    // Finished jobs from earlier builds are what fill a member's disk: a
    // two-target job keeps its own source tree and both package trees. The
    // gateway keeps the state and the log, so the member-side directory is
    // only ever needed while that build runs.
    `find "${REMOTE_JOBS}" -mindepth 1 -maxdepth 1 -type d ! -name ${quote(String(options.jobId))} -exec rm -rf {} + 2>/dev/null || true`,
    `free_kb=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')`,
    `if [ "\${free_kb:-0}" -lt ${String(needGiB * 1024 * 1024)} ]; then echo "not enough free space on the build host: \${free_kb:-0} KiB free, ${String(needGiB)} GiB needed" >&2; exit 4; fi`,
    `if [ ! -d "${REMOTE_SRC}/.git" ]; then`,
    `  echo "cloning ${options.repoUrl ?? DEFAULT_MESH_REPO}"`,
    `  git clone --depth 1 --branch main ${quote(options.repoUrl ?? DEFAULT_MESH_REPO)} "${REMOTE_SRC}" || { echo "mesh clone failed" >&2; exit 3; }`,
    'else',
    `  git -C "${REMOTE_SRC}" fetch --depth 1 origin main && git -C "${REMOTE_SRC}" reset --hard FETCH_HEAD || { echo "mesh update failed" >&2; exit 3; }`,
    'fi',
    'corepack enable --install-directory "$HOME/.dsh/mesh/bin" >/dev/null 2>&1 || true',
    `cd "${REMOTE_SRC}" || { echo "mesh checkout is missing" >&2; exit 3; }`,
    'echo "mesh head $(git rev-parse --short HEAD)"',
    `"${REMOTE_NODE_DIR}/node" code/build/cli.mjs build --stream --out "${out}" --ref ${quote(ref)} --targets ${quote(targets)}${options.buildStamp ? ` --build-stamp ${quote(options.buildStamp)}` : ''}${options.proxyUrl ? ` --proxy ${quote(options.proxyUrl)}` : ''}`,
    'code=$?',
    `ls -1d "${out}"/* 2>/dev/null | head -n 5`,
    'exit $code',
    '',
  ]
  return lines.filter(line => line !== '').join('\n')
}

/**
 * Single-quote a value for bash.
 * @param {string} value text.
 * @returns {string} quoted.
 */
function quote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`
}

/**
 * Build the PowerShell script that runs one job on a Windows member.
 *
 * Windows members have no git and no bash; what they do have is the DSH
 * runtime (`runtime\node\node.exe` + corepack), the system `tar.exe`, and
 * PowerShell. So the checkout is a codeload tarball extracted with tar, and the
 * engine runs exactly as it does on Linux — it is cross-platform and can emit a
 * linux-x64 archive from a Windows host.
 * @param {{jobId: string, ref: string, targets: string[], buildStamp?: string, proxyUrl?: string|null, repoUrl?: string, heapMb?: number, appRoot?: string}} options script input.
 * @returns {string} PowerShell script.
 */
export function windowsBuildScript(options) {
  const repo = options.repoUrl ?? DEFAULT_MESH_REPO
  // Same preflight as the Linux path: free last run's job dir and refuse to
  // start when the drive cannot hold this one (a two-target job is the big one).
  const needGiB = 5 + 3 * options.targets.length
  const codeload = repo
    .replace(/^git\+/u, '')
    .replace(/\.git$/u, '')
    .replace(/^https:\/\/github\.com\//u, 'https://codeload.github.com/')
    .replace(/\/+$/u, '')
  const zipUrl = `${codeload}/zip/refs/heads/main`
  const heap = Number.isSafeInteger(options.heapMb) && options.heapMb > 0 ? options.heapMb : 4096
  const proxy = typeof options.proxyUrl === 'string' ? options.proxyUrl.trim() : ''
  const proxyArgument = proxy === '' ? '' : ` -Proxy ${quotePs(proxy)}`
  const appRoot = String(options.appRoot ?? '').replace(/[\\/]+$/u, '')
  const candidates = [
    ...(appRoot === '' ? [] : [quotePs(`${appRoot}\\runtime\\node`)]),
    '"$env:USERPROFILE\\.dsh\\dsh-mesh\\current\\runtime\\node"',
    '"$env:USERPROFILE\\.dsh\\dsh-person-web\\runtime\\node"',
    '"$env:ProgramFiles\\nodejs"',
  ]
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$root = Join-Path $env:USERPROFILE '.dsh\\mesh'",
    "$src = Join-Path $root 'build-src'",
    "$bin = Join-Path $root 'bin'",
    `$out = Join-Path $root 'build\\${options.jobId}'`,
    'New-Item -ItemType Directory -Force -Path $out, $bin | Out-Null',
    '$nodeDir = $null',
    `foreach ($candidate in @(${candidates.join(', ')})) { if (Test-Path (Join-Path $candidate 'node.exe')) { $nodeDir = $candidate; break } }`,
    "if ($null -eq $nodeDir) { throw 'no node runtime on this member' }",
    // Remove last run's job directory with Node instead of Remove-Item:
    // node_modules paths are longer than MAX_PATH and Remove-Item fails on
    // them halfway through, which is exactly how a member's disk filled up.
    "$buildRoot = Join-Path $root 'build'",
    "$rmScript = \"const fs=require('fs');const p=process.argv[1];fs.rmSync(p,{recursive:true,force:true,maxRetries:5,retryDelay:200})\"",
    `Get-ChildItem -LiteralPath $buildRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne ${quotePs(String(options.jobId))} } | ForEach-Object { & (Join-Path $nodeDir 'node.exe') -e $rmScript $_.FullName 2>$null; if (Test-Path -LiteralPath $_.FullName) { Write-Output ('could not remove a leftover job dir: ' + $_.Name) } }`,
    '$driveFree = 0',
    'try { $driveFree = (Get-PSDrive ((Get-Item $env:USERPROFILE).PSDrive.Name)).Free } catch { $driveFree = (Get-PSDrive C).Free }',
    `if ($driveFree -lt ${String(needGiB * 1024 ** 3)}) { throw ("not enough free space on the build host: {0:N1} GiB free, ${String(needGiB)} GiB needed" -f ($driveFree / 1GB)) }`,
    '$env:PATH = "$bin;$nodeDir;$env:PATH"',
    "$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'",
    "$env:CI = '1'",
    `$env:NODE_OPTIONS = '--max-old-space-size=${String(heap)}'`,
    proxy === '' ? '' : `$env:HTTP_PROXY = ${quotePs(proxy)}; $env:HTTPS_PROXY = $env:HTTP_PROXY`,
    "Write-Output 'downloading the dsh-mesh checkout'",
    // A zip + Expand-Archive instead of the tar.gz: Windows' bsdtar fails on
    // the repository's Chinese doc names ("Invalid empty pathname"), while
    // .NET's zip reader keeps UTF-8 names intact.
    '$archive = Join-Path $root "dsh-mesh.zip"',
    `$curl = Join-Path $env:SystemRoot 'System32\\curl.exe'`,
    // A single reset on the tunnel used to fail the whole nightly build, so the
    // archive is fetched a few times with a growing pause in between. A failed
    // attempt deletes its partial file: a truncated zip must never reach
    // Expand-Archive, which would otherwise fail with a misleading message.
    '$attempts = 4',
    '$downloadCode = 1',
    'for ($attempt = 1; $attempt -le $attempts; $attempt++) {',
    '  Remove-Item -Force $archive -ErrorAction SilentlyContinue',
    `  if (Test-Path $curl) { & $curl -fsSL --connect-timeout 20${proxy === '' ? '' : ` --proxy ${quotePs(proxy)}`} -o $archive '${zipUrl}'; $downloadCode = $LASTEXITCODE } else { try { Invoke-WebRequest -Uri '${zipUrl}' -OutFile $archive -UseBasicParsing${proxyArgument}; $downloadCode = 0 } catch { $downloadCode = 1; Write-Output ('download error: ' + $_.Exception.Message) } }`,
    '  if ($downloadCode -eq 0 -and (Test-Path $archive)) { break }',
    `  Write-Output ('download attempt {0}/{1} failed ({2})' -f $attempt, $attempts, $downloadCode)`,
    '  if ($attempt -lt $attempts) { Start-Sleep -Seconds (3 * $attempt) }',
    '}',
    'if ($downloadCode -ne 0 -or -not (Test-Path $archive)) { throw "mesh download failed ($downloadCode)" }',
    '$extract = Join-Path $root "extract"',
    'Remove-Item -Recurse -Force $src, $extract -ErrorAction SilentlyContinue',
    'New-Item -ItemType Directory -Force -Path $extract | Out-Null',
    'Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force',
    '$inner = Get-ChildItem -Directory $extract | Select-Object -First 1',
    'if ($null -eq $inner) { throw "mesh archive had no top-level directory" }',
    'New-Item -ItemType Directory -Force -Path $src | Out-Null',
    'Move-Item -Path (Join-Path $inner.FullName "*") -Destination $src -Force',
    'Remove-Item -Recurse -Force $extract, $archive -ErrorAction SilentlyContinue',
    'if (-not (Test-Path (Join-Path $src "code\\build\\cli.mjs"))) { throw "mesh checkout is incomplete" }',
    `& (Join-Path $nodeDir 'corepack.cmd') enable --install-directory $bin | Out-Null`,
    'Set-Location $src',
    `& (Join-Path $nodeDir 'node.exe') code/build/cli.mjs build --stream --out $out --ref ${quotePs(options.ref)} --targets ${quotePs(options.targets.join(','))}${options.buildStamp ? ` --build-stamp ${quotePs(options.buildStamp)}` : ''}${proxy === '' ? '' : ` --proxy ${quotePs(proxy)}`}`,
    '$code = $LASTEXITCODE',
    'Get-ChildItem -Directory $out -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty FullName',
    'exit $code',
    '',
  ].filter(line => line !== '').join('\r\n')
}

/**
 * Escape one value for a PowerShell single-quoted string.
 * @param {string} value text.
 * @returns {string} escaped text.
 */
function quotePs(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}

/**
 * Decode the base64 state a Windows member prints.
 *
 * The file is UTF-8 and carries Chinese document names, while the SSH channel
 * uses the console code page; transferring raw bytes avoids the mismatch. Host
 * noise before or after the object is trimmed here.
 * @param {string} stdout remote output.
 * @returns {object} parsed state.
 */
export function decodeWindowsState(stdout) {
  // PowerShell may frame the channel with `#< CLIXML` markers; the payload is
  // the longest base64 run on the output.
  const runs = String(stdout).match(/[A-Za-z0-9+/=]{16,}/gu) ?? []
  const encoded = runs.reduce((best, run) => (run.length > best.length ? run : best), '')
  const text = Buffer.from(encoded, 'base64').toString('utf8')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text)
}

/**
 * Run one PowerShell snippet on a Windows member.
 *
 * `-EncodedCommand` is UTF-16LE base64 and avoids the `cmd.exe` quoting layer
 * that SSH inserts between the caller and PowerShell.
 * @param {string} script PowerShell source.
 * @returns {string} remote command line.
 */
export function powershellCommand(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}

/**
 * SHA-256 of a file.
 * @param {string} file path.
 * @returns {Promise<string>} hex digest.
 */
async function sha256File(file) {
  const hash = createHash('sha256')
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

/**
 * One member build.
 */
export class RemoteBuilder {
  /**
   * @param {{log?: (line: string) => void, packagesDir: string}} options options.
   */
  constructor(options) {
    this.log = options.log ?? (() => {})
    this.packagesDir = options.packagesDir
    /**
     * One queue for every state write this builder makes. A progress snapshot
     * and the final result must never race: the last write has to be the one
     * that says the job is done.
     * @type {Promise<unknown>}
     */
    this.writes = Promise.resolve()
  }

  /**
   * Run one job on a member and settle the local job state.
   * @param {string} jobDir local job directory.
   * @param {{plan: {os?: string, appRoot?: string}, memberName: string, proxyUrl?: string|null, repoUrl?: string, buildStamp?: string, heapMb?: number}} options run options.
   * @returns {Promise<object>} final local state.
   */
  async run(jobDir, options) {
    const state = await readState(jobDir)
    await this.#update(jobDir, { status: 'running', phase: 'prepare', percent: 1, error: null })
    const runner = new SshRunner({ port: 22, ...options.plan }, { log: line => this.log(`remote ${state.member ?? ''}: ${line}`) })
    const windows = options.plan.os === 'windows'
    const script = windows
      ? windowsBuildScript({
        jobId: state.id,
        ref: state.ref,
        targets: state.targets,
        proxyUrl: options.proxyUrl,
        repoUrl: options.repoUrl,
        buildStamp: options.buildStamp,
        heapMb: options.heapMb,
        appRoot: options.plan.appRoot,
      })
      : remoteBuildScript({
        jobId: state.id,
        ref: state.ref,
        targets: state.targets,
        proxyUrl: options.proxyUrl,
        repoUrl: options.repoUrl,
        buildStamp: options.buildStamp,
        heapMb: options.heapMb,
      })
    let percent = 1
    const onLine = (line) => {
      void appendLog(jobDir, line)
      const update = phaseFromLine(line, state.targets)
      if (update === null) return
      const patch = { phase: update.phase }
      if (typeof update.percent === 'number' && update.percent > percent) {
        percent = update.percent
        patch.percent = percent
      }
      if (update.currentTarget !== undefined) patch.currentTarget = update.currentTarget
      // The phase (and especially the target) changes more often than the
      // percent; applying only the percent would leave "打包" without saying
      // which target while the second one is being assembled.
      void this.#update(jobDir, patch)
    }
    try {
      await runner.script(script, windows ? 'windows' : 'linux', onLine)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await appendLog(jobDir, `member build did not finish: ${message}`)
      // Keep the percent the job actually reached: a failure at 20% must not
      // look like a finished job with a red bar at 100%. Settle the state
      // first, then remove the member-side tree; the panel shows the failure
      // while the cleanup runs.
      const settled = await this.#update(jobDir, { status: 'failed', phase: 'failed', error: message, percent })
      await this.#cleanupRemote(runner, jobDir, state.id, windows)
      return settled
    }
    const remote = await this.#readRemoteState(runner, state.id, windows)
    if (remote === null) {
      const message = 'the member finished without writing a job state; see the log for its output'
      await appendLog(jobDir, message)
      const settled = await this.#update(jobDir, { status: 'failed', phase: 'failed', error: message, percent })
      await this.#cleanupRemote(runner, jobDir, state.id, windows)
      return settled
    }
    if (remote.status !== 'done') {
      const message = typeof remote.error === 'string' && remote.error !== '' ? remote.error : `member build ended with status ${String(remote.status)}`
      await appendLog(jobDir, `member job ${String(remote.status)}: ${message}`)
      const status = remote.status === 'needs-fix' ? 'needs-fix' : remote.status === 'smoke-failed' ? 'smoke-failed' : 'failed'
      const settled = await this.#update(jobDir, {
        status,
        phase: remote.phase ?? 'failed',
        error: status === 'failed' ? message : null,
        percent,
        remoteJob: remote.id ?? null,
        remoteWorktree: remote.worktree ?? null,
        workOrder: remote.workOrder ?? null,
        mismatches: remote.mismatches ?? [],
      })
      // A needs-fix job keeps its worktree on the member for the repair flow;
      // every other outcome is settled and the temporary tree can go.
      if (status !== 'needs-fix') await this.#cleanupRemote(runner, jobDir, state.id, windows)
      return settled
    }
    const directories = Array.isArray(remote.artifacts) ? remote.artifacts : []
    const artifacts = []
    // The member finished building but nothing is on this host yet: pulling the
    // archives is its own phase, so the bar does not claim "完成" while several
    // hundred MiB are still moving over the mesh.
    let pulled = 0
    if (directories.length > 0) await this.#update(jobDir, { phase: 'fetch', percent: 96, currentTarget: null })
    for (const artifact of directories) {
      const archive = typeof artifact.archive === 'string' ? artifact.archive : ''
      if (archive === '') continue
      const local = await this.#pull(runner, archive, windows)
      const info = await stat(local)
      const digest = await sha256File(local)
      await writeSidecar(local, digest)
      artifacts.push({
        target: artifact.target,
        archive: local,
        remoteArchive: archive,
        bytes: info.size,
        sha256: digest,
        manifest: artifact.manifest ?? null,
        smoke: artifact.smoke ?? null,
      })
      await appendLog(jobDir, `pulled ${path.basename(local)} (${String(info.size)} bytes, sha256 ${digest.slice(0, 12)}…)`)
      pulled += 1
      await this.#update(jobDir, { phase: 'fetch', percent: 96 + Math.round((3 * pulled) / directories.length) })
    }
    // Archives are on the gateway now; the member-side tree (source,
    // node_modules, both package trees, and the member's copy of the archive)
    // is only temporary data. Settle the job first so the panel does not wait
    // for a multi-minute delete.
    const done = await this.#update(jobDir, {
      status: 'done',
      phase: 'done',
      percent: 100,
      currentTarget: null,
      artifacts,
      remoteJob: remote.id ?? null,
      version: remote.version ?? null,
    })
    await this.#cleanupRemote(runner, jobDir, state.id, windows)
    return done
  }

  /**
   * Delete the member-side job directory once its outcome is settled.
   *
   * The gateway keeps the job state and mirrors the member's output into its
   * own build log, so the member only needs the directory while the build
   * runs. Removing it keeps the next full build from starting on a disk that
   * older jobs filled. Windows deletes through Node's fs.rmSync because
   * node_modules paths are longer than MAX_PATH and Remove-Item gives up on
   * them halfway.
   * @param {SshRunner} runner ssh runner.
   * @param {string} jobDir local job directory (the cleanup is logged there).
   * @param {string} jobId build job id (also the remote directory name).
   * @param {boolean} windows whether the member runs Windows.
   * @returns {Promise<void>} completion.
   */
  async #cleanupRemote(runner, jobDir, jobId, windows) {
    const localPath = `$HOME/.dsh/mesh/build/${jobId}`
    const command = windows
      ? powershellCommand([
          "$ProgressPreference = 'SilentlyContinue'",
          `$out = Join-Path $env:USERPROFILE '.dsh\\mesh\\build\\${jobId}'`,
          "$node = Join-Path $env:USERPROFILE '.dsh\\dsh-mesh\\current\\runtime\\node\\node.exe'",
          "if (-not (Test-Path $node)) { $node = Join-Path $env:USERPROFILE '.dsh\\dsh-person-web\\runtime\\node\\node.exe' }",
          `if ((Test-Path $out) -and (Test-Path $node)) { & $node -e "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:5,retryDelay:200})" $out }`,
          'if (Test-Path $out) { Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue }',
        ].join('; '))
      : `rm -rf "${localPath}"`
    try {
      await runner.runProcess('ssh', [...runner.sshOptions(), runner.target(), command])
      await appendLog(jobDir, `member build dir removed: ${jobId}`)
      this.log(`remote build dir removed: ${jobId}`)
    } catch (error) {
      // Not fatal: the next build's preflight removes leftovers before it
      // checks the free space.
      this.log(`could not remove the remote build dir ${jobId} (the next build retries): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Copy one remote archive into the packages directory.
   * @param {SshRunner} runner ssh runner.
   * @param {string} remote remote path.
   * @returns {Promise<string>} local path.
   */
  async #pull(runner, remote, windows = false) {
    const name = remote.split(/[\\/]/u).pop() ?? path.basename(remote)
    const local = path.join(this.packagesDir, name)
    const temporary = `${local}.part`
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(runner.plan.port ?? 22)]
    if (runner.plan.identityFile) args.push('-i', runner.plan.identityFile)
    // scp runs the path through the remote shell; forward slashes work on both
    // OpenSSH for Windows and POSIX, and a drive-letter path quoted with
    // backslashes confuses the scp argument parser.
    args.push(`${runner.target()}:${windows ? remote.replace(/\\/gu, '/') : remote}`, temporary)
    await runner.runProcess('scp', args)
    await rm(local, { force: true })
    await rename(temporary, local)
    return local
  }

  /**
   * Read the member-side job state.
   * @param {SshRunner} runner ssh runner.
   * @param {string} jobId gateway job id (also the remote directory name).
   * @returns {Promise<object|null>} state.
   */
  async #readRemoteState(runner, jobId, windows = false) {
    try {
      const command = windows
        ? powershellCommand([
            "$ProgressPreference = 'SilentlyContinue'",
            `$out = Join-Path $env:USERPROFILE '.dsh\\mesh\\build\\${jobId}'`,
            '$file = Get-ChildItem -Path $out -Filter state.json -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1',
            // The file is UTF-8 with Chinese doc names; emitting its bytes as
            // base64 avoids the Windows console code page entirely.
            'if ($file) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName)) }',
          ].join('; '))
        : `cat "${REMOTE_JOBS}/${jobId}"/*/state.json`
      const { stdout } = await runner.runProcess('ssh', [...runner.sshOptions(), runner.target(), command])
      const parsed = windows ? decodeWindowsState(stdout) : JSON.parse(stdout)
      if (parsed === null || typeof parsed !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  /**
   * Serialize one state write behind the ones already queued.
   * @param {string} jobDir job directory.
   * @param {object} patch fields.
   * @returns {Promise<object>} the new state.
   */
  #update(jobDir, patch) {
    const next = this.writes.then(() => updateState(jobDir, patch))
    this.writes = next.catch(() => {})
    return next
  }
}

/**
 * Write `<archive>.sha256` next to a package.
 * @param {string} file archive path.
 * @param {string} digest sha-256.
 * @returns {Promise<void>}
 */
async function writeSidecar(file, digest) {
  await writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, 'utf8')
}
