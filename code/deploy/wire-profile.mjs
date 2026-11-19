#!/usr/bin/env node
/**
 * Rewire a flat dsh-mesh install after its files were replaced.
 *
 * Two things must follow the files: the gateway environment (`config/gate.env`
 * decides where DSH_HOME lives and that the gate no longer spawns its own
 * child) and the DSH profile (which links `@local/dsh-mesh` and carries the
 * patch rows the panel and the interop service need). Both are edited in place,
 * keeping every value the operator set by hand.
 *
 * Called by `upgrade-local.mjs`, which is called by `runner.mjs`; also usable on
 * its own with `--no-restart` upgrades for inspection.
 *
 *   node code/deploy/wire-profile.mjs --root <install> --profile <dsh profile> \
 *        --env <gate.env> --dsh-home <home> --workdir <dir> --port 80 --token <interop token>
 *
 * @module @local/dsh-mesh/deploy/wire-profile
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Read `--flag value` pairs.
 * @param {string[]} argv arguments.
 * @returns {Record<string, string>} values.
 */
function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const eq = item.indexOf('=')
    if (eq !== -1) {
      values[item.slice(2, eq)] = item.slice(eq + 1)
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      values[item.slice(2)] = 'true'
      continue
    }
    values[item.slice(2)] = next
    index += 1
  }
  return values
}

/**
 * Quote one YAML scalar when a bare value would not round-trip.
 * @param {string} value text.
 * @returns {string} scalar.
 */
function yamlScalar(value) {
  return /^[A-Za-z0-9._@-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "''")}'`
}

/**
 * Set values in a KEY=VALUE env file, preserving comments and key order.
 * Missing keys are appended in the order given.
 * @param {string} file env file.
 * @param {Array<[string, string]>} pairs values.
 * @returns {string[]} keys that were actually written.
 */
function writeEnv(file, pairs) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const lines = text.split(/\r?\n/u)
  const written = []
  for (const [key, value] of pairs) {
    const at = lines.findIndex(line => line.startsWith(`${key}=`))
    if (at === -1) {
      lines.push(`${key}=${value}`)
      written.push(key)
      continue
    }
    if (lines[at] === `${key}=${value}`) continue
    lines[at] = `${key}=${value}`
    written.push(key)
  }
  const body = lines.join('\n').replace(/\n+$/u, '')
  fs.writeFileSync(file, `${body}\n`, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return written
}

/**
 * Point the profile at this install and keep its patch rows usable.
 * @param {string} profileDir profile directory.
 * @param {string} root install root.
 * @param {string} token interop token ('' keeps the existing one).
 * @returns {string[]} what changed.
 */
function wireProfile(profileDir, root, token) {
  fs.mkdirSync(profileDir, { recursive: true })
  const manifestFile = path.join(profileDir, 'package.json')
  let manifest = {
    name: `dsh-profile-${path.basename(profileDir)}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  if (fs.existsSync(manifestFile)) {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  }
  const changes = []
  manifest.dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const link = `link:${path.join(root, 'plugins', 'dsh-mesh')}`
  if (manifest.dependencies['@local/dsh-mesh'] !== link) {
    manifest.dependencies['@local/dsh-mesh'] = link
    changes.push('dependencies')
  }
  // The panel replaced the standalone wireguard plugin; a leftover link would
  // load two plugins that both claim the same WireGuard panel.
  if ('@local/dsh-wireguard' in manifest.dependencies) {
    delete manifest.dependencies['@local/dsh-wireguard']
    changes.push('drop @local/dsh-wireguard')
  }
  manifest.dsh = manifest.dsh !== null && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  manifest.dsh.profile = manifest.dsh.profile !== null && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  if (!bundles.includes('@local/dsh-mesh')) {
    bundles.push('@local/dsh-mesh')
    changes.push('bundles')
  }
  manifest.dsh.profile.bundles = bundles

  const target = path.join(profileDir, 'node_modules', '@local', 'dsh-mesh')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  fs.symlinkSync(path.join(root, 'plugins', 'dsh-mesh'), target, 'dir')

  // Every sibling plugin in this install (today: xl) rides along: link it into
  // the profile and add its bundle, otherwise the files sit in plugins/ without
  // DSH ever loading them.
  const pluginsRoot = path.join(root, 'plugins')
  const wired = new Set()
  for (const entry of (fs.existsSync(pluginsRoot) ? fs.readdirSync(pluginsRoot) : []).sort()) {
    if (entry === 'dsh-mesh') continue
    // A leftover copy of the plugin directory (`dsh-mesh.bak-20261111-1541`)
    // still carries the original package name. Wiring it would point the
    // profile at stale code, so only a directory whose own name matches the
    // package name counts as a plugin.
    if (entry.startsWith('.') || /[.~_]/u.test(entry)) continue
    const dir = path.join(pluginsRoot, entry)
    const pkgFile = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgFile)) continue
    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    } catch {
      continue
    }
    const name = typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : entry
    if (path.basename(name) !== entry || wired.has(name)) continue
    wired.add(name)
    const linkTarget = path.join(profileDir, 'node_modules', ...name.split('/'))
    fs.mkdirSync(path.dirname(linkTarget), { recursive: true })
    fs.rmSync(linkTarget, { recursive: true, force: true })
    fs.symlinkSync(dir, linkTarget, 'dir')
    const wanted = `link:${dir}`
    if (manifest.dependencies[name] !== wanted) {
      manifest.dependencies[name] = wanted
      changes.push(`dependencies:${name}`)
    }
    const isBundle = pkg.dsh !== null && typeof pkg.dsh === 'object' && pkg.dsh.bundle !== undefined
    if (isBundle && !bundles.includes(name)) {
      bundles.push(name)
      changes.push(`bundles:${name}`)
    }
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

  // Interop rows: keep an existing block (and its plugin id) and only refresh
  // the token; add the block when the install predates it.
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  let patch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
  const block = /# BEGIN (?<owner>dsh-mesh|dsh-person-web) deploy\n(?<body>[\s\S]*?)# END \k<owner> deploy/u.exec(patch)
  if (block === null) {
    const rows = [
      '# BEGIN dsh-mesh deploy',
      '- id: dsh-mesh',
      '  config:',
      `    interopToken: ${yamlScalar(token === '' ? 'change-me' : token)}`,
      '    interopPort: 8765',
      '    interopUseGatePassword: false',
      '# END dsh-mesh deploy',
    ]
    // A freshly initialised profile starts with the comments above and an
    // empty document (`[]`). Appending `- id:` after that empty array is
    // invalid YAML (no document separator), so replace the placeholder
    // instead of appending to it.
    const lines = patch.split(/\r?\n/u)
    const emptyArray = lines.findIndex(line => /^\s*\[\s*\]\s*$/u.test(line))
    const meaningful = lines.filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
    if (emptyArray !== -1 && meaningful.length === 1) {
      lines.splice(emptyArray, 1, ...rows)
      patch = `${lines.join('\n').replace(/\n+$/u, '')}\n`
    } else {
      patch = `${patch.replace(/\n+$/u, '')}${patch.trim() === '' ? '' : '\n'}${rows.join('\n')}\n`
    }
    changes.push('patch block added')
  } else if (token !== '') {
    const body = block.groups?.body ?? ''
    const updated = body.replace(/^(\s*interopToken:\s*).*$/mu, (line, prefix) => `${prefix}${yamlScalar(token)}`)
    if (updated !== body) {
      const owner = block.groups?.owner ?? 'dsh-mesh'
      patch = `${patch.slice(0, block.index)}# BEGIN ${owner} deploy\n${updated}# END ${owner} deploy${patch.slice(block.index + block[0].length)}`
      changes.push('interopToken')
    }
  }
  // A profile that was initialised empty carries a `[]` document placeholder.
  // Once any entry exists, that placeholder is a second document with no
  // separator and DSH refuses the whole profile. Drop it before writing; an
  // empty profile with only `[]` is left alone.
  const patchLines = patch.split(/\r?\n/u)
  const hasEntries = patchLines.some(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#') && !/^\[\s*\]$/u.test(trimmed)
  })
  if (hasEntries && patchLines.some(line => /^\s*\[\s*\]\s*$/u.test(line))) {
    patch = `${patchLines.filter(line => !/^\s*\[\s*\]\s*$/u.test(line)).join('\n').replace(/\n+$/u, '')}\n`
    changes.push('drop empty patch placeholder')
  }
  fs.writeFileSync(patchFile, patch)
  return changes
}

const args = parseArgs(process.argv.slice(2))
const root = path.resolve(args.root ?? '')
const profile = path.resolve(args.profile ?? '')
const envFile = path.resolve(args.env ?? '')
if (root === '' || profile === '' || envFile === '') {
  process.stderr.write('usage: wire-profile.mjs --root <install> --profile <profile> --env <gate.env> [--dsh-home <home>] [--workdir <dir>] [--port <port>] [--token <token>]\n')
  process.exit(2)
}
if (!fs.existsSync(path.join(root, 'plugins', 'dsh-mesh'))) {
  process.stderr.write(`wire-profile: ${root}/plugins/dsh-mesh is missing\n`)
  process.exit(1)
}
const home = args['dsh-home'] ?? ''
const workdir = args.workdir ?? ''
const pairs = []
if (home !== '') pairs.push(['DSH_HOME', home])
if (workdir !== '') pairs.push(['DSH_WORKDIR', workdir])
pairs.push(
  // The split app service owns DSH; a gate that spawns a second copy would
  // fight it for the port.
  ['DSH_GATE_NO_SPAWN', '1'],
  ['DSH_WEB_TOKEN_FILE', path.join(root, 'data', 'dsh-web.json')],
  ['DSH_GATE_MEMBER_PORT', '80'],
)
const written = writeEnv(envFile, pairs)
const changes = wireProfile(profile, root, typeof args.token === 'string' ? args.token : '')
process.stdout.write(`wire-profile: gate.env ${written.length === 0 ? 'unchanged' : `updated (${written.join(', ')})`}\n`)
process.stdout.write(`wire-profile: profile ${changes.length === 0 ? 'unchanged' : `updated (${changes.join(', ')})`}\n`)
process.stdout.write(`wire-profile: @local/dsh-mesh -> ${path.join(root, 'plugins', 'dsh-mesh')}\n`)
