/**
 * The product stage machine A -> B -> C -> D -> A.
 *
 * A main conversation drives one product through four stages:
 *
 *   A  计划与目标   every member proposes, the main conversation decides
 *   B  开发与测试   开发 / 测试 / 研究员; the round's features must have no bug
 *   C  产品经理使用 the product manager uses the product until it is released
 *   D  业务介入     the business staff works with it; release returns to A
 *
 * The product version (`YYYYMMDD.N`) only moves when a released D returns to A:
 * same day bumps the minor number, a new day resets it to `.1`. Everything else
 * in one iteration keeps the version and the sub-stage round.
 *
 * The state is persisted per project directory by the mesh service; this module
 * is the pure part: normalisation, the transition rules, and the lines the
 * member context and the tool result show. It never touches the filesystem.
 *
 * @module @local/dsh-mesh/product-stage
 */

import path from 'node:path'

/** The four development stages, in flow order. */
export const PRODUCT_STAGES = ['A', 'B', 'C', 'D']

/** The one-line name of each stage. */
export const PRODUCT_STAGE_SHORT = {
  A: '计划与目标',
  B: '开发与测试',
  C: '产品经理使用',
  D: '业务介入',
}

/** What each stage requires from its participants. */
export const PRODUCT_STAGE_REQUIREMENTS = {
  A: '所有成员参与并提出建议，最后由主对话决定本轮计划与目标。',
  B: '开发、测试、研究员参与；本轮开发的功能没有 BUG（疑难杂症除外）。',
  C: '产品经理真实使用；发现问题回到 B 阶段，直到产品经理放行。',
  D: '业务人员开展业务工作；发现问题回到 C 阶段，业务放行后回到 A 阶段并升产品版本。',
}

/** The standard member identities the stage checks use. */
export const MEMBER_ROLES = ['产品经理', '研究员', '开发', '测试', '业务']

/** The goals one product version carries. */
export const PRODUCT_GOAL_KEYS = ['product', 'dev', 'research']

/** The display name of each goal. */
export const PRODUCT_GOAL_LABELS = {
  product: '产品目标',
  dev: '开发目标',
  research: '研究目标',
}

/** The only values a goal status may take. */
export const PRODUCT_GOAL_STATUSES = ['未开始', '进行中', '已达成', '未达成']

/** Longest goal text one version keeps. */
export const PRODUCT_GOAL_TEXT_MAX = 300

/** Highest sub-stage round accepted. */
export const PRODUCT_ROUND_MAX = 999

/** `YYYYMMDD.N`, the product version shape. */
const PRODUCT_VERSION_PATTERN = /^(\d{8})\.(\d{1,4})$/u

/**
 * Today's product date, in the host's local time zone.
 * @param {Date} [date] the moment to format.
 * @returns {string} `YYYYMMDD`.
 */
export function productDay(date = new Date()) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${String(value.getFullYear())}${month}${day}`
}

/**
 * Whether a value is a product version.
 * @param {unknown} value candidate.
 * @returns {boolean} true for `YYYYMMDD.N`.
 */
export function isProductVersion(value) {
  return typeof value === 'string' && PRODUCT_VERSION_PATTERN.test(value.trim())
}

/**
 * The version the next release takes.
 *
 * Same day: the minor number grows. A new day (or no usable previous version):
 * the version resets to today's date with `.1`.
 * @param {unknown} previous the previous version.
 * @param {Date} [now] the moment the release is made.
 * @returns {string} the next version.
 */
export function nextProductVersion(previous, now = new Date()) {
  const day = productDay(now)
  const match = typeof previous === 'string' ? PRODUCT_VERSION_PATTERN.exec(previous.trim()) : null
  if (match === null || match[1] !== day) return `${day}.1`
  const minor = Number(match[2]) + 1
  return `${day}.${String(minor)}`
}

/**
 * The project key one stage state is stored under.
 * @param {unknown} cwd project directory.
 * @returns {string} absolute directory, or '' when unknown.
 */
export function productStageKey(cwd) {
  const text = typeof cwd === 'string' ? cwd.trim() : ''
  return text === '' ? '' : path.resolve(text)
}

/**
 * The standard identity stored in one member scope, if it is valid.
 * @param {{role?: unknown}|null|undefined} scope stored scope.
 * @returns {string|null} one of {@link MEMBER_ROLES}, or null.
 */
export function roleOfScope(scope) {
  const role = typeof scope?.role === 'string' ? scope.role.trim() : ''
  return MEMBER_ROLES.includes(role) ? role : null
}

/**
 * The roles a stage expects to participate.
 * @param {string} stage stage letter.
 * @returns {string[]} role names.
 */
export function stageRequiredRoles(stage) {
  if (stage === 'A') return [...MEMBER_ROLES]
  if (stage === 'B') return ['开发', '测试', '研究员']
  if (stage === 'C') return ['产品经理']
  if (stage === 'D') return ['业务']
  return []
}

/**
 * Trim and length-check one goal text.
 * @param {unknown} value raw text.
 * @param {string} key goal key, for the error message.
 * @returns {string|null} trimmed text, or null when cleared.
 */
function normalizeGoalText(value, key) {
  if (typeof value !== 'string') throw new Error(`${key} goal text must be a string`)
  const text = value.trim()
  if (text.length > PRODUCT_GOAL_TEXT_MAX) {
    throw new Error(`${key} goal text is too long: ${String(text.length)} > ${String(PRODUCT_GOAL_TEXT_MAX)} characters`)
  }
  return text === '' ? null : text
}

/**
 * Validate one goal status.
 * @param {unknown} value raw status.
 * @param {string} key goal key, for the error message.
 * @returns {string|null} trimmed status, or null when cleared.
 */
function normalizeGoalStatus(value, key) {
  if (typeof value !== 'string') throw new Error(`${key} goal status must be a string`)
  const status = value.trim()
  if (status === '') return null
  if (!PRODUCT_GOAL_STATUSES.includes(status)) {
    throw new Error(`${key} goal status must be one of ${PRODUCT_GOAL_STATUSES.join(', ')}: ${status}`)
  }
  return status
}

/**
 * Normalise one `goals` patch.
 *
 * A goal is either a text shorthand (`{ product: "..." }`) or an object with
 * `text` / `status`; only the fields present change. Unknown keys are refused so
 * a typo cannot silently disappear.
 * @param {unknown} patch raw goals patch.
 * @returns {Record<string, {text?: string|null, status?: string|null}>} normalised patch.
 */
function normalizeGoalPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('goals must be an object')
  }
  const goals = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!PRODUCT_GOAL_KEYS.includes(key)) {
      throw new Error(`unknown goal: ${key} (expected ${PRODUCT_GOAL_KEYS.join(', ')})`)
    }
    if (typeof value === 'string') {
      goals[key] = { text: normalizeGoalText(value, key) }
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${key} goal must be a string or an object with text/status`)
    }
    for (const field of Object.keys(value)) {
      if (field !== 'text' && field !== 'status') throw new Error(`unknown ${key} goal field: ${field}`)
    }
    const entry = {}
    if (value.text !== undefined) entry.text = normalizeGoalText(value.text, key)
    if (value.status !== undefined) entry.status = normalizeGoalStatus(value.status, key)
    goals[key] = entry
  }
  return goals
}

/**
 * Normalise one `set_product_stage` input.
 * @param {{stage?: unknown, round?: unknown, goals?: unknown}} [input] raw arguments.
 * @returns {{stage?: string, round?: number, goals?: Record<string, object>}} normalised input.
 */
export function normalizeProductStageInput(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('product stage input must be an object')
  }
  const normalized = {}
  if (input.stage !== undefined) {
    if (typeof input.stage !== 'string') throw new Error('stage must be a string')
    const stage = input.stage.trim().toUpperCase()
    if (!PRODUCT_STAGES.includes(stage)) {
      throw new Error(`stage must be one of ${PRODUCT_STAGES.join(', ')}: ${stage}`)
    }
    normalized.stage = stage
  }
  if (input.round !== undefined) {
    const round = input.round
    if (!Number.isSafeInteger(round) || round < 1 || round > PRODUCT_ROUND_MAX) {
      throw new Error(`round must be an integer between 1 and ${String(PRODUCT_ROUND_MAX)}`)
    }
    normalized.round = round
  }
  if (input.goals !== undefined) normalized.goals = normalizeGoalPatch(input.goals)
  if (Object.keys(normalized).length === 0) throw new Error('stage, round, or goals is required')
  return normalized
}

/**
 * Merge a goals patch into the stored goals.
 * @param {Record<string, object>|undefined} previous stored goals.
 * @param {Record<string, object>|undefined} patch normalised patch.
 * @returns {Record<string, {text: string|null, status: string|null}>} merged goals.
 */
function mergeGoals(previous, patch) {
  const goals = {}
  for (const key of PRODUCT_GOAL_KEYS) {
    const stored = previous?.[key]
    if (stored === undefined) continue
    const text = typeof stored?.text === 'string' && stored.text !== '' ? stored.text : null
    const status = PRODUCT_GOAL_STATUSES.includes(stored?.status) ? stored.status : null
    if (text !== null || status !== null) goals[key] = { text, status }
  }
  if (patch === undefined) return goals
  for (const key of PRODUCT_GOAL_KEYS) {
    const change = patch[key]
    if (change === undefined) continue
    const base = goals[key] ?? { text: null, status: null }
    const text = change.text !== undefined ? change.text : base.text
    // A goal without text is not a goal: a status-only update to an unset goal
    // must not create an empty entry every reader would have to ignore.
    if (text === null) {
      delete goals[key]
      continue
    }
    const status = (change.status !== undefined ? change.status : base.status) ?? '未开始'
    goals[key] = { text, status }
  }
  return goals
}

/**
 * Normalise one stage state read from disk.
 *
 * A record with an unusable version, stage or round is dropped: the reader then
 * treats the project as "no stage yet" instead of acting on a corrupt state.
 * @param {unknown} value stored record.
 * @returns {object|null} clean state, or null.
 */
export function normalizeStoredProductStage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const stage = typeof value.stage === 'string' ? value.stage.trim().toUpperCase() : ''
  if (!PRODUCT_STAGES.includes(stage)) return null
  const version = typeof value.version === 'string' ? value.version.trim() : ''
  if (!isProductVersion(version)) return null
  const round = Number.isSafeInteger(value.round) && value.round >= 1 && value.round <= PRODUCT_ROUND_MAX
    ? value.round
    : null
  if (round === null) return null
  const goals = mergeGoals(value.goals, undefined)
  const participation = {}
  if (value.participation !== null && typeof value.participation === 'object' && !Array.isArray(value.participation)) {
    for (const [conversationId, entry] of Object.entries(value.participation)) {
      const id = conversationId.trim()
      if (id === '' || entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const turn = Number.isSafeInteger(entry.turn) ? entry.turn : null
      const at = typeof entry.at === 'string' ? entry.at : ''
      participation[id] = { turn, at }
    }
  }
  return {
    version,
    stage,
    round,
    goals,
    participation,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : '',
  }
}

/**
 * Apply one input to the previous state.
 *
 * Only a released D returning to A moves the version and the round. Entering A
 * any other way keeps the version; the sub-stage round follows the iteration
 * unless the caller names one. Participation resets whenever the (stage, round)
 * pair changes.
 * @param {object|null} previous stored state, or null for the first call.
 * @param {{stage?: string, round?: number, goals?: object}} input normalised input.
 * @param {Date} [now] the moment of the change.
 * @returns {object} the next state, without `updatedBy`.
 */
export function applyProductStage(previous, input, now = new Date()) {
  const prev = previous ?? null
  const stage = input.stage ?? prev?.stage ?? 'A'
  const version = prev === null || !isProductVersion(prev.version)
    ? nextProductVersion(null, now)
    : stage === 'A' && prev.stage === 'D'
      ? nextProductVersion(prev.version, now)
      : prev.version
  const automaticRound = prev === null
    ? 1
    : stage === 'A' && prev.stage === 'D' ? prev.round + 1 : prev.round
  const round = Math.min(input.round ?? automaticRound, PRODUCT_ROUND_MAX)
  const reset = prev === null || prev.stage !== stage || prev.round !== round
  return {
    version,
    stage,
    round,
    goals: mergeGoals(prev?.goals, input.goals),
    participation: reset ? {} : { ...(prev?.participation ?? {}) },
    updatedAt: new Date(now).toISOString(),
    updatedBy: '',
  }
}

/**
 * One goal's model-facing line.
 * @param {{text?: string|null, status?: string|null}|undefined} goal stored goal.
 * @returns {string} text.
 */
function goalLine(goal) {
  const text = typeof goal?.text === 'string' && goal.text !== '' ? goal.text : ''
  if (text === '') return '未设置'
  const status = PRODUCT_GOAL_STATUSES.includes(goal?.status) ? goal.status : '未开始'
  return `${text}（${status}）`
}

/**
 * The current stage's participant view.
 * @param {object} state stage state.
 * @param {object[]} tasks tracked member conversations.
 * @param {Record<string, object>} scopes conversation id -> stored scope.
 * @returns {{entries: object[], required: object[], missing: object[], missingRoles: string[], roleLess: object[]}} view.
 */
export function productStageParticipants(state, tasks, scopes = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  const entries = list.map((task) => {
    const conversationId = String(task?.conversationId ?? '')
    const stored = scopes[conversationId] ?? null
    const role = roleOfScope(stored) ?? roleOfScope(task?.profile)
    return {
      conversationId,
      role,
      identity: typeof stored?.identity === 'string' && stored.identity !== ''
        ? stored.identity
        : (typeof task?.profile?.identity === 'string' ? task.profile.identity : null),
      statusLabel: typeof task?.statusLabel === 'string' ? task.statusLabel : (typeof task?.status === 'string' ? task.status : '未知'),
      participated: Boolean(state?.participation?.[conversationId]),
    }
  })
  const requiredRoles = stageRequiredRoles(state?.stage)
  const required = state?.stage === 'A'
    ? entries
    : entries.filter(entry => entry.role !== null && requiredRoles.includes(entry.role))
  const missing = required.filter(entry => !entry.participated)
  const missingRoles = state?.stage === 'A'
    ? []
    : requiredRoles.filter(role => !entries.some(entry => entry.role === role))
  const roleLess = entries.filter(entry => entry.role === null)
  return { entries, required, missing, missingRoles, roleLess }
}

/**
 * One participant label.
 * @param {{role: string|null, conversationId: string}} entry participant.
 * @returns {string} label.
 */
function participantLabel(entry) {
  return entry.role === null ? entry.conversationId : `${entry.role} ${entry.conversationId}`
}

/**
 * The participation lines for one stage state.
 * @param {object} state stage state.
 * @param {object[]} tasks tracked conversations.
 * @param {Record<string, object>} scopes conversation id -> stored scope.
 * @returns {string[]} lines.
 */
export function formatProductStageParticipation(state, tasks, scopes = {}) {
  const view = productStageParticipants(state, tasks, scopes)
  const done = view.required.filter(entry => entry.participated)
  const lines = [
    `- 本轮参与：${String(done.length)}/${String(view.required.length)}${done.length === 0 ? '' : `（${done.map(participantLabel).join('；')}）`}`,
  ]
  if (view.missing.length > 0) {
    lines.push(`- 未参与：${view.missing.map(participantLabel).join('、')}`)
  }
  if (view.missingRoles.length > 0) {
    lines.push(`- 没有成员会话的标准身份：${view.missingRoles.join('、')}`)
  }
  if (view.roleLess.length > 0) {
    lines.push(`- 标准身份未设置：${view.roleLess.map(entry => `${entry.conversationId}（${entry.identity ?? '身份未设置'}）`).join('、')}；用 set_member_scope { "conversationId": "<会话id>", "role": "开发" } 设置。`)
  }
  return lines
}

/**
 * The next `set_product_stage` calls for the current stage.
 * @param {object} state stage state.
 * @returns {string[]} lines.
 */
export function formatProductStageNextCalls(state) {
  const calls = []
  if (state.stage === 'A') calls.push('进入 B 阶段 { "stage": "B" }')
  if (state.stage === 'B') calls.push('进入 C 阶段 { "stage": "C" }', '回 A 阶段重新计划 { "stage": "A" }')
  if (state.stage === 'C') calls.push('进入 D 阶段 { "stage": "D" }', '发现问题回 B 阶段 { "stage": "B" }')
  if (state.stage === 'D') calls.push('业务放行回 A 阶段 { "stage": "A" }（自动升版本）', '发现问题回 C 阶段 { "stage": "C" }')
  return [
    `- 下一步（set_product_stage）：${calls.join('；')}。`,
    `- 子阶段或目标：同一阶段下一轮 { "stage": "${state.stage}", "round": ${String(state.round + 1)} }；只更新目标状态 { "goals": { "dev": { "status": "已达成" } } }。`,
  ]
}

/**
 * The whole stage block the member context carries.
 * @param {object} state stage state.
 * @param {object[]} tasks tracked conversations.
 * @param {Record<string, object>} scopes conversation id -> stored scope.
 * @returns {string[]} lines.
 */
export function formatProductStageLines(state, tasks, scopes = {}) {
  return [
    `[产品阶段] ${state.version} · ${state.stage} 阶段（第 ${String(state.round)} 轮迭代）· ${PRODUCT_STAGE_SHORT[state.stage] ?? ''}`,
    `- 阶段要求：${PRODUCT_STAGE_REQUIREMENTS[state.stage] ?? ''}`,
    ...PRODUCT_GOAL_KEYS.map(key => `- ${PRODUCT_GOAL_LABELS[key]}：${goalLine(state.goals?.[key])}`),
    ...formatProductStageParticipation(state, tasks, scopes),
    ...formatProductStageNextCalls(state),
  ]
}

/**
 * The tool result for one `set_product_stage` call.
 * @param {object} state saved state.
 * @param {{created?: boolean, tasks?: object[], scopes?: Record<string, object>, warnings?: string[]}} [options] extra facts.
 * @returns {string} text.
 */
export function formatProductStageResult(state, options = {}) {
  const lines = [
    `${options.created === true ? '产品阶段已建立' : '产品阶段已更新'}：${state.version} · ${state.stage} 阶段（第 ${String(state.round)} 轮迭代）`,
    `- 阶段要求：${PRODUCT_STAGE_REQUIREMENTS[state.stage] ?? ''}`,
    ...PRODUCT_GOAL_KEYS.map(key => `- ${PRODUCT_GOAL_LABELS[key]}：${goalLine(state.goals?.[key])}`),
    ...formatProductStageParticipation(state, options.tasks ?? [], options.scopes ?? {}),
    ...formatProductStageNextCalls(state),
    ...(Array.isArray(options.warnings) && options.warnings.length > 0
      ? ['[放行检查]', ...options.warnings.map(line => `- ${line}`)]
      : []),
  ]
  return lines.join('\n')
}

/**
 * The warnings the previous stage leaves behind when the flow moves on.
 *
 * These are advisory: the main conversation decides whether a missing
 * participant or an unmet goal is acceptable. Every unmet exit criterion is
 * named so a stage cannot advance silently.
 * @param {object|null} previous the state before this call.
 * @param {object[]} tasks tracked conversations.
 * @param {Record<string, object>} scopes conversation id -> stored scope.
 * @returns {string[]} warning lines.
 */
export function productStageWarnings(previous, tasks, scopes = {}) {
  if (previous === null || previous === undefined) return []
  const view = productStageParticipants(previous, tasks, scopes)
  const warnings = []
  if (view.missing.length > 0) {
    warnings.push(`离开 ${previous.stage} 阶段时还有成员没有参与本轮：${view.missing.map(participantLabel).join('、')}`)
  }
  if (view.missingRoles.length > 0) {
    warnings.push(`离开 ${previous.stage} 阶段时没有这些身份的成员会话：${view.missingRoles.join('、')}`)
  }
  if (view.roleLess.length > 0) {
    warnings.push(`离开 ${previous.stage} 阶段时仍有成员没有设置标准身份：${view.roleLess.map(entry => entry.conversationId).join('、')}`)
  }
  if (previous.stage === 'A' && !previous.goals?.product?.text) {
    warnings.push('离开 A 阶段时产品目标还没有设置')
  }
  if (previous.stage === 'B' && previous.goals?.dev?.status !== '已达成') {
    warnings.push('离开 B 阶段时开发目标状态不是「已达成」')
  }
  if (previous.stage === 'C' && previous.goals?.product?.status !== '已达成') {
    warnings.push('离开 C 阶段时产品目标状态不是「已达成」')
  }
  return warnings
}
