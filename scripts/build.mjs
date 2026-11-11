import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function buildHost() {
  const result = await build({
    entryPoints: [path.join(root, 'src/index.ts')],
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })
  if (result.errors.length > 0) throw new Error('Host build failed')
  const code = result.outputFiles?.[0]?.text
  if (!code) throw new Error('Host build produced no output')
  await writeFile(path.join(root, 'index.js'), code, 'utf8')
}

/**
 * Bundle the standalone WireGuard control service. The deployment package
 * ships the output as code/wireguard/control-service.js, so this step keeps
 * the artifact reproducible from the TypeScript source in src/wireguard.
 */
async function buildControlService() {
  const result = await build({
    entryPoints: [path.join(root, 'src/wireguard/control-service.ts')],
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })
  if (result.errors.length > 0) throw new Error('Control service build failed')
  const code = result.outputFiles?.[0]?.text
  if (!code) throw new Error('Control service build produced no output')
  await writeFile(path.join(root, 'code', 'wireguard', 'control-service.js'), code, 'utf8')
}

async function buildClient() {
  const result = await build({
    entryPoints: [path.join(root, 'src/client/index.tsx')],
    write: false,
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'chrome120',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    minify: true,
    legalComments: 'none',
    loader: {
      '.css': 'text',
      '.svg': 'dataurl',
      '.png': 'dataurl',
    },
    logLevel: 'info',
  })
  const code = result.outputFiles?.[0]?.text
  if (!code) throw new Error('Client build produced no output')
  // Do not re-indent the generated code: esbuild prints strings that contain a
  // newline as multi-line template literals, and adding leading spaces to those
  // lines would silently change the string value (for example `'\n'` became
  // `'\n    '`). The wrapper needs no indentation to stay valid.
  const wrapped = `window.__ModuleLoader__.load({\n  id: '@local/dsh-mesh',\n  factory(require) {\n    var module = { exports: {} };\n    var exports = module.exports;\n${code}\n    return module.exports;\n  },\n});\n`
  await writeFile(path.join(root, 'client.js'), wrapped, 'utf8')
}

// Optional target names keep it possible to rebuild only one bundle, which
// matters because client.js depends on the installed UI packages.
const requested = new Set(process.argv.slice(2))
const wants = (name) => requested.size === 0 || requested.has(name)

if (wants('host')) await buildHost()
if (wants('control')) await buildControlService()
if (wants('client')) await buildClient()
console.log(`Built ${[...requested.size === 0 ? ['host', 'control', 'client'] : requested].join(', ')}`)
