import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHysteriaServerConfig, planDirectLinkServer } from '../code/gate/hysteria.mjs'

const SERVER_YAML = `listen: :8443
tls:
  cert: /etc/hysteria/cert.pem
  key: /etc/hysteria/key.pem
auth:
  type: password
  password: B-vxn0qM5RVNzj_Qe42hZELp
bandwidth:
  up: 100 mbps
  down: 100 mbps
`

test('a server config yields the password and the certificate path', () => {
  assert.deepEqual(parseHysteriaServerConfig(SERVER_YAML), {
    password: 'B-vxn0qM5RVNzj_Qe42hZELp',
    cert: '/etc/hysteria/cert.pem',
  })
})

test('a Windows server config keeps its backslash path and quoted password', () => {
  const parsed = parseHysteriaServerConfig([
    'listen: :9443',
    'tls:',
    "  cert: 'C:\\ProgramData\\hysteria2\\cert.pem'",
    'auth:',
    '  type: password',
    '  password: "two words"',
    '',
  ].join('\r\n'))
  assert.equal(parsed.password, 'two words')
  assert.equal(parsed.cert, 'C:\\ProgramData\\hysteria2\\cert.pem')
})

test('a config without an auth block has no password', () => {
  assert.equal(parseHysteriaServerConfig('listen: :8443\n').password, '')
})

test('a second client on the same server and port reuses it', () => {
  const links = [
    { server: { ip: '10.66.66.2' }, client: { ip: '10.66.66.3' }, port: 8443, publicHost: '43.172.94.59' },
  ]
  const plan = planDirectLinkServer(links, '10.66.66.2', 8443)
  assert.equal(plan.reuse, true)
  assert.equal(plan.link?.publicHost, '43.172.94.59')
})

test('a different server only owns its own links', () => {
  const links = [{ server: { ip: '10.66.66.3' }, client: { ip: '10.66.66.4' }, port: 8443 }]
  assert.equal(planDirectLinkServer(links, '10.66.66.2', 8443).reuse, false)
})

test('a different port on a configured server is refused', () => {
  const links = [{ server: { ip: '10.66.66.2' }, client: { ip: '10.66.66.3' }, port: 8443 }]
  assert.throws(() => planDirectLinkServer(links, '10.66.66.2', 9443), /udp\/8443/u)
})

test('no stored links means a fresh server', () => {
  assert.deepEqual(planDirectLinkServer([], '10.66.66.2', 8443), { reuse: false, link: null })
  assert.deepEqual(planDirectLinkServer(undefined, '10.66.66.2', 8443), { reuse: false, link: null })
})
