import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { registerTools } from '../src/lib/tools.mjs'

/**
 * Register the mesh tools against a fake host and return `compact_subagent`.
 * @param {object} [options] fake host behavior.
 * @param {number|null} [options.percent] initial context percentage.
 * @param {string} [options.status] child status.
 * @param {object|null} [options.result] compaction result, null for "nothing to compact".
 * @param {boolean} [options.noCompaction] hide the compaction service.
 * @param {boolean} [options.coldChild] child agent is not resident.
 * @returns {Promise<{tool: object, dataDir: string, calls: string[], state: object}>} harness.
 */
async function harness(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'compact-subagent-'))
  const calls = []
  const state = {
    percent: options.percent === undefined ? 20 : options.percent,
    afterPercent: options.afterPercent === undefined ? 10 : options.afterPercent,
  }
  const child = { id: 'child-1', status: options.status ?? 'idle', session: { id: 'child-1' } }
  const pressure = () => ({
    projectedTokens: Math.round((state.percent / 100) * 1_000_000),
    contextWindow: 1_000_000,
  })
  const compaction = {
    async compactNow() {
      calls.push('compact')
      if (options.result === null) return null
      state.percent = state.afterPercent
      return options.result ?? { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 5000, summarySeq: 9 }
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => () => {},
    get(name) {
      if (name === 'subagents') return { resolveName: async () => 'child-1' }
      if (name === 'agents') return { get: id => (options.coldChild === true || id !== 'child-1' ? undefined : child) }
      if (name === 'sessionProjections') return { snapshot: () => ({ values: { contextPressure: pressure() } }) }
      if (name === 'agentPresets') return options.noCompaction === true ? undefined : { serviceFor: () => compaction }
      if (name === 'compaction') return undefined
      return undefined
    },
  }
  const tools = []
  const service = {
    config: {},
    dataDir,
    repositoryRoot: process.cwd(),
    members: async () => ({ local: { id: 'local', name: 'a', ip: '127.0.0.1' }, members: [] }),
  }
  registerTools(ctx, { tools: { register: tool => { tools.push(tool) } } }, service)
  const tool = tools.find(candidate => candidate.name === 'compact_subagent')
  if (tool === undefined) throw new Error('compact_subagent was not registered')
  return { tool, dataDir, calls, state }
}

/**
 * Run the tool with a caller agent.
 * @param {object} tool tool definition.
 * @param {string} name child name.
 * @returns {Promise<object>} tool result.
 */
function run(tool, name = 'reviewer') {
  return tool.execute({ agent: name }, { agent: { id: 'parent' } })
}

test('compact_subagent leaves a child below 35% untouched', async () => {
  const { tool, dataDir, calls } = await harness({ percent: 20 })
  try {
    const result = await run(tool)
    assert.equal(result.ok, true)
    assert.equal(result.data.compacted, false)
    assert.equal(result.data.percentBefore, 20)
    assert.match(result.text, /子代理 reviewer：上下文 20%.*未超过 35%，没有压缩/u)
    assert.deepEqual(calls, [])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('compact_subagent compacts a child above 35% and reports both figures', async () => {
  const { tool, dataDir, calls } = await harness({ percent: 47.5, afterPercent: 12.5 })
  try {
    const result = await run(tool)
    assert.equal(result.ok, true)
    assert.equal(result.data.compacted, true)
    assert.equal(result.data.percentBefore, 47.5)
    assert.equal(result.data.percentAfter, 12.5)
    assert.equal(result.data.shadowedCount, 3)
    assert.match(result.text, /上下文 47\.5% 超过 35%，已压缩/u)
    assert.match(result.text, /替换 3 项历史（约 5k tokens），现在 12\.5%。/u)
    assert.deepEqual(calls, ['compact'])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('compact_subagent treats exactly 35.0% as not over the threshold', async () => {
  const { tool, dataDir, calls } = await harness({ percent: 35 })
  try {
    const result = await run(tool)
    assert.equal(result.data.compacted, false)
    assert.match(result.text, /35%（350k \/ 1M tokens），未超过 35%/u)
    assert.deepEqual(calls, [])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('compact_subagent refuses a running child', async () => {
  const { tool, dataDir, calls } = await harness({ percent: 80, status: 'running' })
  try {
    await assert.rejects(run(tool), /正在运行（running），压缩只能在它这一轮结束/u)
    assert.deepEqual(calls, [])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('compact_subagent refuses a child that is not resident', async () => {
  const { tool, dataDir } = await harness({ coldChild: true })
  try {
    await assert.rejects(run(tool), /当前不在内存中/u)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('compact_subagent reports a child with nothing to compact', async () => {
  const { tool, dataDir } = await harness({ percent: 60, result: null })
  try {
    const result = await run(tool)
    assert.equal(result.ok, true)
    assert.equal(result.data.compacted, false)
    assert.match(result.text, /已尝试压缩，但没有可压缩的历史/u)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('compact_subagent fails loudly when the host has no compaction service', async () => {
  const { tool, dataDir } = await harness({ percent: 60, noCompaction: true })
  try {
    await assert.rejects(run(tool), /没有可用的压缩服务/u)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('compact_subagent requires an agent name', async () => {
  const { tool, dataDir } = await harness()
  try {
    await assert.rejects(tool.execute({}, { agent: { id: 'parent' } }), /agent is required/u)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
