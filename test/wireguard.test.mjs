import assert from 'node:assert/strict'
import test from 'node:test'
import {
  discoverMembers,
  fetchPeers,
  isValidMemberId,
  normalizeAddress,
  parseTargetCookie,
  probeMember,
  wireGuardIdentity,
} from '../code/shared/wireguard.mjs'
import { memberCookiePrefix } from '../code/shared/cookies.mjs'

const clientState = {
  version: 1,
  role: 'client',
  settings: {
    vpnCidr: '10.66.66.0/24',
    serverIp: '10.66.66.1',
    joinCode: 'settings-code',
  },
  server: { running: false, peers: [] },
  client: {
    connected: true,
    name: 'desktop-1',
    serverUrl: 'http://8.140.245.107:51821',
    assignedIp: '10.66.66.4',
    joinCode: 'client-code',
    lastHandshakeAt: '2026-11-10T05:47:11.196Z',
  },
}

test('wireGuardIdentity reads the client identity', () => {
  const identity = wireGuardIdentity(clientState)
  assert.equal(identity.role, 'client')
  assert.equal(identity.vpnCidr, '10.66.66.0/24')
  assert.equal(identity.serverIp, '10.66.66.1')
  assert.equal(identity.serverUrl, 'http://8.140.245.107:51821')
  assert.equal(identity.joinCode, 'client-code')
  assert.equal(identity.selfIp, '10.66.66.4')
  assert.equal(identity.selfName, 'desktop-1')
  assert.equal(identity.connected, true)
})

test('normalizeAddress strips IPv4-mapped and bracket notation', () => {
  assert.equal(normalizeAddress('::ffff:10.66.66.2'), '10.66.66.2')
  assert.equal(normalizeAddress('[fd00::1]'), 'fd00::1')
  assert.equal(normalizeAddress('not an ip'), '')
})

test('fetchPeers asks the control panel with the stored join code', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(String(url))
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, peers: [{ name: 'peer-a', ip: '10.66.66.2', online: true }] }
      },
    }
  }
  const result = await fetchPeers(clientState, { fetchImpl })
  assert.equal(result.error, null)
  assert.equal(result.source, 'client-control-panel')
  assert.equal(result.peers.length, 1)
  assert.equal(result.peers[0].ip, '10.66.66.2')
  assert.match(seen[0], /\/peers\?code=client-code$/u)
})

test('fetchPeers prefers the live server control panel over the state snapshot', async () => {
  const state = {
    version: 1,
    role: 'server',
    settings: { vpnCidr: '10.66.66.0/24', serverIp: '10.66.66.1', controlPort: 51821 },
    server: {
      running: true,
      peers: [{ name: 'desktop', ip: '10.66.66.4', online: false, lastHandshakeAt: '2026-11-10T12:02:30.000Z' }],
    },
    client: {},
  }
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(String(url))
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          state: {
            server: {
              peers: [{ name: 'desktop', ip: '10.66.66.4', online: true, lastHandshakeAt: '2026-11-10T13:03:13.000Z' }],
            },
          },
        }
      },
    }
  }
  const result = await fetchPeers(state, { fetchImpl, timeoutMs: 100 })
  assert.equal(result.source, 'server-control-panel')
  assert.equal(result.error, null)
  assert.equal(result.peers[0].online, true)
  assert.equal(seen[0], 'http://127.0.0.1:51821/api/dsh-wireguard/state')
})

test('discoverMembers merges self, the server, and every peer', async () => {
  const fetchImpl = async (url) => {
    const text = String(url)
    if (text.includes('/peers?')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            peers: [
              { name: 'VM-0-2-ubuntu', ip: '10.66.66.2', online: true },
              { name: 'ecs-92994806', ip: '10.66.66.3', online: false },
              { name: 'desktop-1', ip: '10.66.66.4', online: true },
            ],
          }
        },
      }
    }
    if (text.startsWith('http://10.66.66.2/')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, service: 'dsh-person-web', name: 'VM-0-2-ubuntu' }
        },
      }
    }
    return { ok: false, status: 404, async json() { return {} } }
  }
  const snapshot = await discoverMembers({
    state: clientState,
    fetchImpl,
    timeoutMs: 100,
    self: { name: 'self', ip: '10.66.66.4' },
  })
  assert.equal(snapshot.self.id, 'local')
  assert.equal(snapshot.members.length, 3)
  assert.deepEqual(snapshot.members.map(member => member.id).sort(), ['10.66.66.1', '10.66.66.2', '10.66.66.3'])
  const ubuntu = snapshot.members.find(member => member.id === '10.66.66.2')
  assert.equal(ubuntu.dsh, true)
  assert.equal(ubuntu.port, 80)
  const ecs = snapshot.members.find(member => member.id === '10.66.66.3')
  assert.equal(ecs.dsh, false)
  assert.equal(ecs.online, false)
  const server = snapshot.members.find(member => member.id === '10.66.66.1')
  assert.equal(server.dsh, false)
})

test('probeMember accepts only the member service marker', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return { ok: true, service: 'some-other-service' } },
  })
  const probe = await probeMember('10.66.66.2', { fetchImpl, ports: [80], timeoutMs: 50 })
  assert.equal(probe.ok, false)
  assert.match(probe.error, /not dsh-person-web/u)
})

test('member ids and target cookies are validated', () => {
  assert.equal(isValidMemberId('local'), true)
  assert.equal(isValidMemberId('10.66.66.2'), true)
  assert.equal(isValidMemberId('fd00::1'), true)
  assert.equal(isValidMemberId('../etc/passwd'), false)
  assert.equal(parseTargetCookie('local'), 'local')
  assert.equal(parseTargetCookie('10.66.66.2'), '10.66.66.2')
  assert.equal(parseTargetCookie(encodeURIComponent('fd00::1')), 'fd00::1')
  assert.equal(parseTargetCookie('nope'), null)
  assert.equal(parseTargetCookie('%E0%A4%A'), null)
  assert.equal(memberCookiePrefix('10.66.66.2'), 'dsh_m_10.66.66.2_')
  assert.equal(memberCookiePrefix('fd00::1'), 'dsh_m_fd00%3A%3A1_')
})
