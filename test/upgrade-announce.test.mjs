/**
 * Pre-upgrade announcements: classification, stop messages, resume.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createInteropService } from '../src/lib/interop-service.mjs'
import { clearMemberSessions, markMemberSession } from '../src/lib/member-sessions.mjs'
import {
  UPGRADE_LEADER_MESSAGE,
  UPGRADE_MEMBER_MESSAGE,
  UPGRADE_PLAIN_MESSAGE,
  UPGRADE_RESUME_MESSAGE,
  announceUpgrade,
  armUpgradeResume,
  classifyUpgradeConversation,
  readUpgradePlan,
  resumeUpgradeConversations,
  sessionCalledTool,
} from '../src/lib/upgrade-announce.mjs'

/**
 * One fake live agent.
 * @param {string} id session id.
 * @param {{status?: string, events?: object[]}} [options] knobs.
 * @returns {object} agent.
 */
function fakeAgent(id, options = {}) {
  const steered = []
  const followed = []
  const events = options.events ?? []
  return {
    id,
    status: options.status ?? 'running',
    session: { ownEvents: () => events },
    steered,
    followed,
    steer(message) { steered.push(message) },
    followup(message) { followed.push(message) },
  }
}

/**
 * A host context that only exposes an agent registry.
 * @param {object[]} agents live agents.
 * @param {object} [registry] extra registry methods (resume).
 * @returns {object} context.
 */
function fakeCtx(agents, registry = {}) {
  const api = {
    list: () => agents,
    get: id => agents.find(agent => agent.id === id),
    ...registry,
  }
  return { get: name => name === 'agents' ? api : undefined }
}

/**
 * Build a service pointed at a temporary plan file.
 * @returns {Promise<{planFile: string, dir: string}>} paths.
 */
async function planFileOf() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-upgrade-'))
  return { planFile: path.join(dir, 'upgrade-plan.json'), dir }
}

test('a conversation that called call_member is a leader; interop sessions are members', () => {
  clearMemberSessions()
  const leader = fakeAgent('s-leader', { events: [{ type: 'tool/call', data: { name: 'call_member' } }] })
  const plain = fakeAgent('s-plain')
  const member = fakeAgent('s-member')
  markMemberSession('s-member')
  assert.equal(sessionCalledTool(leader, 'call_member'), true)
  assert.equal(sessionCalledTool(plain, 'call_member'), false)
  assert.equal(classifyUpgradeConversation(leader), 'leader')
  assert.equal(classifyUpgradeConversation(plain), 'plain')
  assert.equal(classifyUpgradeConversation(member), 'member')
  clearMemberSessions()
})

test('only running conversations are told to stop, each with its own message', async () => {
  clearMemberSessions()
  const { planFile, dir } = await planFileOf()
  try {
    const leader = fakeAgent('s-leader', { events: [{ type: 'tool/call', data: { name: 'call_member' } }] })
    const plain = fakeAgent('s-plain')
    const member = fakeAgent('s-member')
    markMemberSession('s-member')
    const idle = fakeAgent('s-idle', { status: 'idle' })
    const result = await announceUpgrade(fakeCtx([leader, plain, member, idle]), { planFile })
    assert.equal(result.ok, true)
    assert.equal(result.already, false)
    assert.deepEqual(result.counts, { leader: 1, member: 1, plain: 1 })
    assert.deepEqual(leader.steered.map(message => message.content[0].text), [UPGRADE_LEADER_MESSAGE])
    assert.deepEqual(member.steered.map(message => message.content[0].text), [UPGRADE_MEMBER_MESSAGE])
    assert.deepEqual(plain.steered.map(message => message.content[0].text), [UPGRADE_PLAIN_MESSAGE])
    assert.deepEqual(idle.steered, [], 'an idle conversation is not touched')
    // Member conversations are resumed by their initiator, so the plan holds
    // only the leader and plain ones.
    assert.deepEqual(result.counts.leader + result.counts.plain, 2)
    const plan = await readUpgradePlan(planFile)
    assert.deepEqual(plan.sessions.map(entry => entry.kind).sort(), ['leader', 'plain'])
    assert.equal(plan.resumedAt, null)
    // Every injected message is a user message, which is what the conversation
    // is expected to treat as an instruction.
    assert.equal(leader.steered[0].role, 'user')
    assert.equal(leader.steered[0].source.kind, 'user')
  } finally {
    clearMemberSessions()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a retried announcement reuses the plan instead of stopping twice', async () => {
  const { planFile, dir } = await planFileOf()
  try {
    const plain = fakeAgent('s-plain')
    const ctx = fakeCtx([plain])
    const first = await announceUpgrade(ctx, { planFile, now: () => Date.parse('2026-11-26T04:50:00Z') })
    assert.equal(first.already, false)
    const second = await announceUpgrade(ctx, { planFile, now: () => Date.parse('2026-11-26T04:51:00Z') })
    assert.equal(second.already, true)
    assert.equal(plain.steered.length, 1, 'the same conversation is not stopped again')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('after the restart, leaders and plain conversations resume while members do not', async () => {
  const { planFile, dir } = await planFileOf()
  try {
    const leader = fakeAgent('s-leader')
    const plain = fakeAgent('s-plain')
    await announceUpgrade(fakeCtx([leader, plain]), { planFile })
    // The restart dropped every live agent: the resume has to bring them back,
    // and they come up idle before the resume message can be queued.
    leader.status = 'idle'
    plain.status = 'idle'
    const resumed = []
    const ctx = fakeCtx([], {
      resume: async ({ resumeSessionId }) => {
        resumed.push(resumeSessionId)
        return { agent: resumeSessionId === 's-leader' ? leader : plain }
      },
    })
    const result = await resumeUpgradeConversations(ctx, { planFile })
    assert.equal(result.resumed, 2)
    assert.deepEqual(resumed.sort(), ['s-leader', 's-plain'])
    assert.deepEqual(leader.followed.map(message => message.content[0].text), [UPGRADE_RESUME_MESSAGE])
    assert.deepEqual(plain.followed.map(message => message.content[0].text), [UPGRADE_RESUME_MESSAGE])
    const plan = await readUpgradePlan(planFile)
    assert.equal(typeof plan.resumedAt, 'string', 'the plan is consumed once')
    const again = await resumeUpgradeConversations(ctx, { planFile })
    assert.equal(again.skipped, true)
    assert.equal(leader.followed.length, 1, 'a resume never repeats')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a conversation that is already running again is not resumed', async () => {
  const { planFile, dir } = await planFileOf()
  try {
    const busy = fakeAgent('s-busy')
    await announceUpgrade(fakeCtx([busy]), { planFile })
    busy.status = 'running'
    const ctx = fakeCtx([busy])
    const result = await resumeUpgradeConversations(ctx, { planFile })
    assert.equal(result.resumed, 0)
    assert.deepEqual(busy.followed, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the resume is armed with the two-minute delay and fires once', async () => {
  const { planFile, dir } = await planFileOf()
  try {
    const plain = fakeAgent('s-plain')
    await announceUpgrade(fakeCtx([plain]), { planFile })
    let delay = -1
    let fire = null
    const armed = await armUpgradeResume(fakeCtx([plain]), {
      planFile,
      delayMs: 1234,
      setTimeout: (fn, ms) => {
        delay = ms
        fire = fn
        return { unref() {} }
      },
    })
    assert.equal(armed, true)
    assert.equal(delay, 1234)
    plain.status = 'idle'
    fire()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(plain.followed.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the interop endpoint announces and serves the plan', async () => {
  clearMemberSessions()
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-upgrade-route-'))
  const planFile = path.join(dir, 'upgrade-plan.json')
  const plain = fakeAgent('s-plain')
  const ctx = fakeCtx([plain])
  const service = createInteropService({
    ctx,
    settings: {
      bind: '127.0.0.1',
      port: 0,
      token: 'test-token',
      dataDir: dir,
      workdir: dir,
      workspaceRoot: path.join(dir, 'workspaces'),
      stateFile: path.join(dir, 'conversations.json'),
      logFile: path.join(dir, 'interop.log'),
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      approve: true,
      preset: 'workspace-write',
      agentPreset: 'standard',
      tokenSource: 'test',
    },
    upgradePlanFile: planFile,
    log: () => {},
    retry: false,
  })
  const { port } = await service.start()
  const call = async (method, url) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { authorization: 'Bearer test-token' },
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    const prepared = await call('POST', '/v1/upgrade/prepare')
    assert.equal(prepared.status, 200)
    assert.equal(prepared.body.ok, true)
    assert.equal(prepared.body.announced, 1)
    assert.deepEqual(prepared.body.counts, { leader: 0, member: 0, plain: 1 })
    const plan = await call('GET', '/v1/upgrade/plan')
    assert.equal(plan.body.plan.sessions.length, 1)
    assert.equal(JSON.parse(await readFile(planFile, 'utf8')).version, 1)
  } finally {
    await service.dispose()
    clearMemberSessions()
    await rm(dir, { recursive: true, force: true })
  }
})
