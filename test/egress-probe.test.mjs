import assert from 'node:assert/strict'
import test from 'node:test'
import { EGRESS_PROBE_SOURCE, formatEgressLine, formatMemberMesh } from '../src/lib/egress-probe.mjs'

test('the one-line report states the proxy port, latency and bandwidth', () => {
  assert.equal(
    formatEgressLine({ proxyPort: 8080, egress: { ok: true, latencyMs: 118.4, downMbps: 42.3 } }),
    '本机代理端口 8080；经代理出网实测：延迟 118 ms，下行 42.3 Mbps。',
  )
  assert.equal(
    formatEgressLine({ proxyPort: 1080, egress: { ok: true, latencyMs: 90, downMbps: null } }),
    '本机代理端口 1080；经代理出网实测：延迟 90 ms（带宽未测）。',
  )
})

test('a failed probe reports the reason and no invented numbers', () => {
  assert.equal(
    formatEgressLine({ proxyPort: 8080, egress: { ok: false, error: 'ECONNREFUSED' } }),
    '本机代理端口 8080；经代理出网实测失败：ECONNREFUSED。',
  )
  assert.equal(
    formatEgressLine({ proxyPort: null, egress: { ok: false, error: null } }),
    '本机没有检测到代理端口；经代理出网实测失败。',
  )
})

test('the conversation context is one egress line plus the raw tokens', () => {
  assert.equal(
    formatMemberMesh({
      link: true,
      proxyPort: 8080,
      egress: { ok: true, latencyMs: 118, downMbps: 42.3 },
      tokens: { github: 'ghp_example', gitee: 'gitee_example' },
    }),
    [
      '本机代理端口 8080；经代理出网实测：延迟 118 ms，下行 42.3 Mbps。',
      'GitHub token: ghp_example',
      'Gitee token: gitee_example',
    ].join('\n'),
  )
  assert.equal(
    formatMemberMesh({ link: true, proxyPort: 8080, egress: { ok: true, latencyMs: 118 }, tokens: { github: null, gitee: null } }),
    '本机代理端口 8080；经代理出网实测：延迟 118 ms（带宽未测）。',
  )
  // No link in the mesh networking config: no egress words at all.
  assert.equal(
    formatMemberMesh({ link: false, proxyPort: null, egress: null, tokens: { github: 'ghp_example', gitee: null } }),
    'GitHub token: ghp_example',
  )
  assert.equal(formatMemberMesh(null), '')
})

test('the probe module is a self-contained ES module', () => {
  assert.match(EGRESS_PROBE_SOURCE, /^\s*import http from 'node:http'/u)
  assert.match(EGRESS_PROBE_SOURCE, /process\.argv\[2\]/u)
  assert.doesNotMatch(EGRESS_PROBE_SOURCE, /socks5|1080/u)
  assert.match(EGRESS_PROBE_SOURCE, /console\.log\(JSON\.stringify/u)
  // It must not depend on repository files: it is piped to the target's Node.
  assert.doesNotMatch(EGRESS_PROBE_SOURCE, /@local\/|dsh-mesh\/shared/u)
})
