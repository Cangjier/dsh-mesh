import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HysteriaService } from '../code/gate/hysteria.mjs'

/**
 * Minimal `ServerResponse` double for the SSE route.
 * @returns {object} fake response.
 */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end() {},
    once() {},
    body() {
      return this.chunks.join('')
    },
  }
}

/**
 * Poll until `check()` holds.
 * @param {() => boolean} check condition.
 * @param {number} [timeoutMs] budget.
 * @returns {Promise<void>} completion.
 */
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('condition was not reached in time')
}

test('the gateway streams hysteria link changes', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-hysteria-events-'))
  await mkdir(path.join(home, 'hysteria'), { recursive: true })
  const service = new HysteriaService({
    home,
    stateFile: path.join(home, 'wireguard-state.json'),
    log: () => {},
    isAdmitted: () => true,
    snapshot: async () => ({}),
  })
  try {
    const response = fakeResponse()
    const request = { method: 'GET', headers: {}, once() {} }
    const handled = await service.handle(request, response, new URL('http://gate.invalid/__gate/hysteria/events'))
    assert.equal(handled, true)
    assert.equal(response.status, 200)
    assert.match(response.headers['content-type'], /text\/event-stream/u)
    assert.match(response.body(), /event: ready/u)

    await writeFile(path.join(home, 'hysteria', 'links.json'), JSON.stringify({
      ok: true,
      links: [{
        server: { id: 'a', name: 'A', ip: '10.66.66.2' },
        client: { id: 'b', name: 'B', ip: '10.66.66.3' },
        updatedAt: new Date().toISOString(),
      }],
    }), 'utf8')
    await waitFor(() => response.body().includes('"kind":"links"'))
    assert.match(response.body(), /"kind":"links"/u)
  } finally {
    service.close()
    await rm(home, { recursive: true, force: true })
  }
})
