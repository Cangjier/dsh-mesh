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
 * The product version (`YYYYMMDD.N.R`, major.minor.revision) only moves when a
 * released D returns to A: same day bumps the minor number, a new day resets
 * major/minor to today's date with `.1`, and the revision only ever grows so
 * every release keeps a unique, increasing number. Everything else in one
 * iteration keeps the version and the sub-stage round.
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

/**
 * The goal categories the format names as examples; any other short category
 * word is accepted too, since a product may have goals the list does not name.
 */
export const PRODUCT_GOAL_CATEGORIES = [
  '应用功能', '应用界面', '应用服务', '算法',
  '数据', '性能', '稳定性', '安全', '兼容性',
  '工程质量', '体验', '交付', '文档',
]

/** A short example list for one-line hints; the full list is for refusals and docs. */
export const PRODUCT_GOAL_CATEGORY_HINT = '应用功能 / 应用界面 / 应用服务 / 算法 / 数据 / 性能 / …'

/** The fixed goal shape: a category, the current state, and the expected state. */
export const PRODUCT_GOAL_FORMAT = '<类别> 现状 <现在怎样>，预期 <要变成怎样>。'

/**
 * The one shape every goal text takes: `<category> 现状 <current>，预期 <expected>。`
 * The category is any short word (the examples are in
 * {@link PRODUCT_GOAL_CATEGORIES}); a free sentence is refused so every goal
 * says what is true now and what should become true.
 */
const PRODUCT_GOAL_TEXT_PATTERN = /^(.{1,20}?)[\s：:]*现状[\s：:]*(.+?)[，,；;]\s*预期[\s：:]*(.+?)[。.]?$/u

/** Highest sub-stage round accepted. */
export const PRODUCT_ROUND_MAX = 999

/**
 * `YYYYMMDD.N.R`, the product version shape (major.minor.revision).
 *
 * The revision is optional so a state written by an older build (`YYYYMMDD.N`)
 * still reads: {@link normalizeProductVersion} then supplies revision 1.
 */
const PRODUCT_VERSION_PATTERN = /^(\d{8})\.(\d{1,4})(?:\.(\d{1,9}))?$/u

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
 * Whether a value names a product version, in either the current
 * `major.minor.revision` shape or the pre-revision `major.minor` one.
 * @param {unknown} value candidate.
 * @returns {boolean} true for `YYYYMMDD.N` or `YYYYMMDD.N.R`.
 */
export function isProductVersion(value) {
  return normalizeProductVersion(value) !== null
}

/**
 * The version in `major.minor.revision` shape.
 *
 * A legacy `YYYYMMDD.N` state has no revision stored; it reads as revision 1,
 * so the state is not dropped and the next release continues from there.
 * @param {unknown} value candidate.
 * @returns {string|null} `YYYYMMDD.N.R`, or null when unreadable.
 */
export function normalizeProductVersion(value) {
  const match = typeof value === 'string' ? PRODUCT_VERSION_PATTERN.exec(value.trim()) : null
  if (match === null) return null
  const revision = match[3] === undefined ? '1' : match[3]
  return `${match[1]}.${match[2]}.${revision}`
}

/**
 * The version the next release takes.
 *
 * Same day: the minor number grows. A new day (or no usable previous version):
 * major/minor reset to today's date with `.1`. The revision never resets: it
 * is the previous revision plus one, whatever the day or the minor did.
 * @param {unknown} previous the previous version.
 * @param {Date} [now] the moment the release is made.
 * @returns {string} the next version.
 */
export function nextProductVersion(previous, now = new Date()) {
  const day = productDay(now)
  const match = typeof previous === 'string' ? PRODUCT_VERSION_PATTERN.exec(previous.trim()) : null
  if (match === null) return `${day}.1.1`
  // A legacy two-part version counts as revision 1.
  const revision = (match[3] === undefined ? 1 : Number(match[3])) + 1
  if (match[1] !== day) return `${day}.1.${String(revision)}`
  const minor = Number(match[2]) + 1
  return `${day}.${String(minor)}.${String(revision)}`
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
 * @param {unknown} [category] explicit category; omitted means parse it from the text.
 * @returns {string|null} trimmed text, or null when cleared.
 */
function normalizeGoalText(value, key, category) {
  if (typeof value !== 'string') throw new Error(`${key} goal text must be a string`)
  let text = value.trim()
  if (text.length > PRODUCT_GOAL_TEXT_MAX) {
    throw new Error(`${key} goal text is too long: ${String(text.length)} > ${String(PRODUCT_GOAL_TEXT_MAX)} characters`)
  }
  if (text === '') return null
  if (category !== undefined) {
    const chosen = normalizeGoalCategory(category, key)
    let body = text
    // Accept both the full fixed shape and the "现状 …，预期 …" tail; an
    // explicitly chosen category wins, so a repeated prefix is dropped.
    if (body.startsWith(chosen)) body = body.slice(chosen.length)
    body = body.trim().replace(/^[：:\s]+/u, '')
    if (!/^现状/u.test(body)) {
      throw new Error(`${key} goal text with category must start with 现状 …，预期 …；收到：${text.slice(0, 80)}`)
    }
    text = `${chosen} ${body}`
  }
  const match = PRODUCT_GOAL_TEXT_PATTERN.exec(text)
  if (match === null) throw goalFormatError(key, text)
  const parsedCategory = match[1].trim().replace(/[\s：:，,。；;]+$/u, '')
  const current = match[2].trim().replace(/[\s，,；;。.]+$/u, '')
  const expected = match[3].trim().replace(/[\s。.]+$/u, '')
  if (parsedCategory === '' || /[，,。；;\n]/u.test(parsedCategory) || current === '' || expected === '') {
    throw goalFormatError(key, text)
  }
  const normalized = `${parsedCategory} 现状 ${current}，预期 ${expected}。`
  if (normalized.length > PRODUCT_GOAL_TEXT_MAX) {
    throw new Error(`${key} goal text is too long after formatting: ${String(normalized.length)} > ${String(PRODUCT_GOAL_TEXT_MAX)} characters`)
  }
  return normalized
}

/**
 * Normalise one explicit goal category.
 * @param {unknown} value raw category.
 * @param {string} key goal key, for the error message.
 * @returns {string} the category without a trailing colon or punctuation.
 */
function normalizeGoalCategory(value, key) {
  if (typeof value !== 'string') throw new Error(`${key} goal category must be a string`)
  const category = value.trim().replace(/[：:，,。；;\s]+$/u, '')
  if (category === '' || category.length > 20 || /[，,。；;\n]/u.test(category)) {
    throw new Error(`${key} goal category must be 1-20 characters without punctuation: ${value.slice(0, 40)}`)
  }
  return category
}

/**
 * The refusal for a goal that does not name a category, the current state and
 * the expected state in the fixed shape.
 * @param {string} key goal key, for the message.
 * @param {string} text the rejected text.
 * @returns {Error} the error to throw.
 */
function goalFormatError(key, text) {
  return new Error(
    `${PRODUCT_GOAL_LABELS[key] ?? key}的 text 必须是「${PRODUCT_GOAL_FORMAT}」`
    + `（类别如 ${PRODUCT_GOAL_CATEGORIES.join(' / ')} / …；例：应用功能 现状 只能做基础建模，预期 支持参数化特征与历史回放。）；`
    + `收到：${text.slice(0, 80)}`,
  )
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
      if (field !== 'text' && field !== 'status' && field !== 'category') {
        throw new Error(`unknown ${key} goal field: ${field}`)
      }
    }
    if (value.category !== undefined && value.text === undefined) {
      throw new Error(`${key} goal category must be sent together with text`)
    }
    const entry = {}
    if (value.text !== undefined) entry.text = normalizeGoalText(value.text, key, value.category)
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
  const version = normalizeProductVersion(value.version)
  if (version === null) return null
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
  const roundStartedAt = typeof value.roundStartedAt === 'string' && value.roundStartedAt !== ''
    ? value.roundStartedAt
    : ''
  const audits = value.audits !== null && typeof value.audits === 'object' && !Array.isArray(value.audits)
    && Number.isSafeInteger(value.audits.count) && value.audits.count >= 0
    ? {
        count: value.audits.count,
        lastAt: typeof value.audits.lastAt === 'string' ? value.audits.lastAt : '',
      }
    : null
  return {
    version,
    stage,
    round,
    goals,
    participation,
    ...(roundStartedAt === '' ? {} : { roundStartedAt }),
    ...(audits === null ? {} : { audits }),
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
  // A legacy two-part version is upgraded here, so the state always keeps the
  // current three-part shape and the revision continues from it.
  const previousVersion = normalizeProductVersion(prev?.version)
  const version = previousVersion === null
    ? nextProductVersion(null, now)
    : stage === 'A' && prev.stage === 'D'
      ? nextProductVersion(previousVersion, now)
      : previousVersion
  const automaticRound = prev === null
    ? 1
    : stage === 'A' && prev.stage === 'D' ? prev.round + 1 : prev.round
  const round = Math.min(input.round ?? automaticRound, PRODUCT_ROUND_MAX)
  const reset = prev === null || prev.stage !== stage || prev.round !== round
  const previousStart = typeof prev?.roundStartedAt === 'string' && prev.roundStartedAt !== ''
    ? prev.roundStartedAt
    : (typeof prev?.updatedAt === 'string' ? prev.updatedAt : '')
  const audits = reset ? null : (prev?.audits ?? null)
  return {
    version,
    stage,
    round,
    goals: mergeGoals(prev?.goals, input.goals),
    participation: reset ? {} : { ...(prev?.participation ?? {}) },
    ...(audits === null ? {} : { audits: { ...audits } }),
    // A goal-only update keeps the round's start: replies collected before it
    // still count, and the participation window cannot move under the caller.
    roundStartedAt: reset || previousStart === '' ? new Date(now).toISOString() : previousStart,
    updatedAt: new Date(now).toISOString(),
    updatedBy: '',
  }
}

/**
 * The definitions of every big stage, as a block the member context leads with.
 *
 * The main conversation and its members must share one vocabulary for A/B/C/D;
 * repeating the full definition in each snapshot keeps the stage name from
 * being the only clue to what a stage is asking for.
 * @returns {string[]} lines.
 */
export function formatProductStageDefinitions() {
  return [
    '[产品阶段定义] 产品按 A → B → C → D → A 循环：',
    ...PRODUCT_STAGES.map(stage => `- ${stage} ${PRODUCT_STAGE_SHORT[stage]}：${PRODUCT_STAGE_REQUIREMENTS[stage]}`),
  ]
}

/**
 * The moment the current sub-stage round started.
 * @param {object} state stage state.
 * @returns {number} epoch milliseconds, or NaN when the state carries no usable time.
 */
function roundStartedMs(state) {
  return Date.parse(
    typeof state?.roundStartedAt === 'string' && state.roundStartedAt !== ''
      ? state.roundStartedAt
      : (typeof state?.updatedAt === 'string' ? state.updatedAt : ''),
  )
}

/**
 * How many member replies returned to the main conversation this round.
 *
 * One accepted reply is one call_member unit: `wait_member` and the fallback
 * delivery share the same reply table, so a reply is counted once no matter
 * which path handed it over.
 * @param {object} state stage state.
 * @param {object[]} tasks tracked member conversations.
 * @returns {number} replies accepted since the round started.
 */
export function countCallMemberReplies(state, tasks) {
  const startedAt = roundStartedMs(state)
  if (!Number.isFinite(startedAt)) return 0
  let count = 0
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const reply of Array.isArray(task?.replies) ? task.replies : []) {
      const at = typeof reply?.at === 'string' ? Date.parse(reply.at) : Number.NaN
      if (Number.isFinite(at) && at >= startedAt) count += 1
    }
  }
  return count
}

/**
 * One big stage's configured call_member budget.
 * @param {Record<string, number>|null|undefined} budgets per-stage map.
 * @param {string} stage stage letter.
 * @returns {number|null} the budget, or null when that stage has none.
 */
export function callMemberBudgetFor(budgets, stage) {
  const value = budgets?.[stage]
  return Number.isSafeInteger(value) && value >= 1 ? value : null
}

/**
 * Render the configured per-stage budgets for a model-facing line.
 *
 * A stage without an explicit budget shows `默认`: the snapshot's stage block
 * resolves it to the live default (twice the participating members).
 * @param {Record<string, number>|null|undefined} budgets per-stage map.
 * @returns {string} "A 13 / B 默认 / C 2 / D 默认".
 */
export function formatCallMemberBudgetSettings(budgets) {
  const map = budgets !== null && typeof budgets === 'object' && !Array.isArray(budgets) ? budgets : {}
  return PRODUCT_STAGES.map((stage) => {
    const value = callMemberBudgetFor(map, stage)
    return `${stage} ${value === null ? '默认' : String(value)}`
  }).join(' / ')
}

/**
 * The budget a stage runs on when the main conversation did not set one.
 *
 * The default scales with the members that stage actually expects: twice their
 * number. A stage with no member yet gets one call rather than zero, so the
 * context does not declare a budget exhausted before there is anyone to call.
 * @param {object} state stage state.
 * @param {object[]} tasks tracked member conversations.
 * @param {Record<string, object>} scopes conversation id -> stored scope.
 * @returns {number} default budget.
 */
export function defaultCallMemberBudget(state, tasks, scopes = {}) {
  const count = productStageParticipants(state, tasks, scopes).required.length
  return Math.max(1, count * 2)
}

/**
 * The budget lines for one round, including the exhausted emphasis.
 *
 * Every big stage has its own budget. A stage without an explicit setting runs
 * on {@link defaultCallMemberBudget} (twice its participating members); there
 * is no shared number and no unlimited state.
 * @param {object} state stage state.
 * @param {object[]} tasks tracked member conversations.
 * @param {Record<string, number>|null|undefined} budgets per-stage budget map.
 * @param {Record<string, object>} [scopes] conversation id -> stored scope.
 * @returns {string[]} lines.
 */
export function formatCallMemberBudget(state, tasks, budgets, scopes = {}) {
  const explicit = callMemberBudgetFor(budgets, state?.stage)
  const budget = explicit ?? defaultCallMemberBudget(state, tasks, scopes)
  const source = explicit === null ? '默认 = 参与成员数 × 2' : '已设置'
  const used = countCallMemberReplies(state, tasks)
  const remaining = Math.max(0, budget - used)
  const lines = [
    `- call_member 预算（${state.stage} 阶段）：本轮已用 ${String(used)}/${String(budget)}，剩余 ${String(remaining)}（${source}）`,
  ]
  if (remaining > 0) return lines
  lines.push(
    `[call_member 预算用尽] ${state.stage} 阶段本轮预算 ${String(budget)} 次已用完`
    + `（已有 ${String(used)} 条成员回复返回主对话）。不要再派新任务：必须进入下一个阶段，`
    + '并用 set_product_stage 及时更新阶段和目标状态；本轮参与未齐时，先 wait_member 取回已派任务的回复。',
  )
  return lines
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
 * One tracked conversation's status label, in the same vocabulary the member
 * snapshot uses (空闲 / 进行中 / 异常中止).
 * @param {object} task tracked conversation.
 * @returns {string} label.
 */
function participantStatus(task) {
  if (typeof task?.statusLabel === 'string' && task.statusLabel !== '') return task.statusLabel
  const status = typeof task?.status === 'string' ? task.status : ''
  if (status === 'running' || status === 'starting') return '进行中'
  if (status === 'completed') return '空闲'
  if (status === 'failed' || status === 'interrupted') return '异常中止'
  return status === '' ? '未知' : status
}

/**
 * The newest reply time recorded on one task.
 * @param {object} task tracked conversation.
 * @returns {number} epoch milliseconds, or 0 when no reply has an `at`.
 */
function latestReplyAt(task) {
  let latest = 0
  for (const reply of Array.isArray(task?.replies) ? task.replies : []) {
    const at = typeof reply?.at === 'string' ? Date.parse(reply.at) : Number.NaN
    if (Number.isFinite(at) && at > latest) latest = at
  }
  return latest
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
  // A reply after the round started counts even if the participation map was
  // never written (tasks created before `originCwd`, a plugin restart between
  // the reply and the record, or a state restored from an older build).
  const startedAt = roundStartedMs(state)
  const entries = list.map((task) => {
    const conversationId = String(task?.conversationId ?? '')
    const stored = scopes[conversationId] ?? null
    const role = roleOfScope(stored) ?? roleOfScope(task?.profile)
    const replyAt = latestReplyAt(task)
    return {
      conversationId,
      role,
      identity: typeof stored?.identity === 'string' && stored.identity !== ''
        ? stored.identity
        : (typeof task?.profile?.identity === 'string' ? task.profile.identity : null),
      statusLabel: participantStatus(task),
      failed: task?.status === 'failed' || task?.status === 'interrupted',
      participated: Boolean(state?.participation?.[conversationId])
        || (Number.isFinite(startedAt) && replyAt >= startedAt),
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
 *
 * Member conversation statuses (进行中 / 空闲 / 异常中止) are deliberately not
 * part of the member context: the context names who still owes this round an
 * answer, not what their conversations are doing. Tool results keep the
 * statuses so a refusal can explain an interrupted conversation.
 * @param {object} state stage state.
 * @param {object[]} tasks tracked conversations.
 * @param {Record<string, object>} scopes conversation id -> stored scope.
 * @param {{statuses?: boolean}} [options] `statuses: false` omits the conversation status.
 * @returns {string[]} lines.
 */
export function formatProductStageParticipation(state, tasks, scopes = {}, options = {}) {
  const withStatuses = options.statuses !== false
  const view = productStageParticipants(state, tasks, scopes)
  const done = view.required.filter(entry => entry.participated)
  const missingLabel = entry => `${participantLabel(entry)}${withStatuses ? `（${entry.statusLabel}${entry.failed ? '，需先恢复会话' : ''}）` : ''}`
  const lines = [
    `- 本轮参与：${String(done.length)}/${String(view.required.length)}${done.length === 0 ? '' : `（${done.map(participantLabel).join('；')}）`}`,
  ]
  if (view.missing.length > 0) {
    lines.push(`- 未参与：${view.missing.map(missingLabel).join('、')}`)
  }
  if (view.missing.length > 0 || view.missingRoles.length > 0) {
    lines.push('- 本轮参与未齐：先给未参与成员派任务（call_member），收到回复后再换阶段；现在换阶段或开新一轮会被拒绝。')
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
 * The possible next moves of one stage: a condition and the call it implies.
 *
 * The list is intentionally conditional rather than a single "next step": the
 * flow can advance, go back for rework, start another round of the same stage,
 * or only update a goal, and the main conversation decides which applies.
 * @param {string} stage current stage letter.
 * @param {number} round the next sub-stage round for the same stage.
 * @returns {{when: string, call: string}[]} moves, in flow order.
 */
function productStageMoves(stage, round) {
  if (stage === 'A') {
    return [
      { when: '所有成员已参与建议、本轮计划与目标已经确定', call: '{ "stage": "B" }' },
      { when: '计划还需要在同一阶段继续讨论或补充', call: `{ "round": ${String(round)} }` },
      { when: '只需要更新产品目标或状态', call: '{ "goals": { "product": { "status": "进行中" } } }' },
    ]
  }
  if (stage === 'B') {
    return [
      { when: '本轮功能已经没有 BUG（疑难杂症除外），可以交给产品经理使用', call: '{ "stage": "C" }' },
      { when: '发现问题需要回到计划重新定目标', call: '{ "stage": "A" }' },
      { when: '本轮还需要继续修复或验证', call: `{ "round": ${String(round)} }` },
      { when: '只需要更新开发目标状态', call: '{ "goals": { "dev": { "status": "已达成" } } }' },
    ]
  }
  if (stage === 'C') {
    return [
      { when: '产品经理真实使用后放行', call: '{ "stage": "D" }' },
      { when: '产品经理发现问题需要修复', call: '{ "stage": "B" }' },
      { when: '验收还需要多轮', call: `{ "round": ${String(round)} }` },
      { when: '只需要更新产品目标状态', call: '{ "goals": { "product": { "status": "已达成" } } }' },
    ]
  }
  if (stage === 'D') {
    return [
      { when: '业务人员放行、开启下一轮（产品版本自动升级）', call: '{ "stage": "A" }' },
      { when: '业务发现问题需要产品经理确认', call: '{ "stage": "C" }' },
      { when: '业务验证还需要多轮', call: `{ "round": ${String(round)} }` },
      { when: '只需要更新目标状态', call: '{ "goals": { "product": { "status": "已达成" } } }' },
    ]
  }
  return []
}

/**
 * The numbered "后续可能走向" block for one stage.
 * @param {object} state stage state.
 * @returns {string[]} lines.
 */
export function formatProductStageNextMoves(state) {
  const current = Number.isSafeInteger(state?.round) ? state.round : 1
  const round = Math.min(current + 1, PRODUCT_ROUND_MAX)
  const moves = productStageMoves(state?.stage, round)
  return [
    '后续可能走向：',
    ...moves.map((move, index) => `${String(index + 1)}. 如果${move.when}，则 set_product_stage(${move.call})`),
  ]
}

/**
 * The whole stage block the member context carries.
 * @param {object} state stage state.
 * @param {object[]} tasks tracked conversations.
 * @param {Record<string, object>} scopes conversation id -> stored scope.
 * @param {{callMemberBudget?: unknown, statuses?: boolean}} [options] self budget and status switch.
 * @returns {string[]} lines.
 */
export function formatProductStageLines(state, tasks, scopes = {}, options = {}) {
  return [
    `[产品阶段] ${state.version} · ${state.stage} 阶段（第 ${String(state.round)} 轮迭代）· ${PRODUCT_STAGE_SHORT[state.stage] ?? ''}`,
    ...formatCallMemberBudget(state, tasks, options.callMemberBudget, scopes),
    `- 阶段要求：${PRODUCT_STAGE_REQUIREMENTS[state.stage] ?? ''}`,
    ...PRODUCT_GOAL_KEYS.map(key => `- ${PRODUCT_GOAL_LABELS[key]}：${goalLine(state.goals?.[key])}`),
    `- 目标文本格式：${PRODUCT_GOAL_FORMAT}（类别如 ${PRODUCT_GOAL_CATEGORY_HINT}）`,
    ...formatProductStageParticipation(state, tasks, scopes, { statuses: options.statuses }),
    ...formatProductStageNextMoves(state),
  ]
}

/**
 * The reasons the current round's participants are not ready to advance.
 *
 * An advancing change (next stage or a new sub-stage round) is refused while
 * any required participant is still missing: the stage exists to make every
 * role answer before the product moves on. Backward rework is not gated by
 * this list, because it does not release anything.
 * @param {object} state current stage state.
 * @param {object[]} tasks tracked conversations.
 * @param {Record<string, object>} scopes conversation id -> stored scope.
 * @returns {string[]} blocker lines; empty means the round may advance.
 */
export function productStageParticipationBlockers(state, tasks, scopes = {}) {
  const view = productStageParticipants(state, tasks, scopes)
  const lines = []
  for (const entry of view.missing) {
    lines.push(`${participantLabel(entry)} 还没有参与本轮（${entry.statusLabel}${entry.failed ? '，需先恢复会话' : ''}）`)
  }
  for (const role of view.missingRoles) {
    lines.push(`没有${role}身份的成员会话`)
  }
  return lines
}

/**
 * Whether one change advances the flow: the next stage or a new sub-stage
 * round of the same stage. Backward rework and goal-only updates do not count.
 * @param {object|null} previous state before the call.
 * @param {object} next planned state.
 * @returns {boolean} true when the change advances the flow.
 */
export function isAdvancingProductStage(previous, next) {
  if (previous === null || previous === undefined || next === null || next === undefined) return false
  if (previous.stage === next.stage) return next.round !== previous.round
  const order = { A: 0, B: 1, C: 2, D: 3 }
  const from = order[previous.stage]
  const to = order[next.stage]
  if (from === undefined || to === undefined) return false
  return to > from || (previous.stage === 'D' && next.stage === 'A')
}

/**
 * The refusal text when an advancing change finds missing participants.
 * @param {object} previous current state.
 * @param {object} next planned state.
 * @param {string[]} blockers reasons from {@link productStageParticipationBlockers}.
 * @returns {string} text.
 */
export function formatProductStageBlocked(previous, next, blockers) {
  return [
    `无法进入 ${next.stage} 阶段（第 ${String(next.round)} 轮迭代）：本轮参与人员不满足要求，阶段状态没有改变。`,
    `- 当前：${previous.version} · ${previous.stage} 阶段（第 ${String(previous.round)} 轮迭代）`,
    '参与检查：',
    ...blockers.map(line => `- ${line}`),
    '先让这些成员在本轮回复（call_member 派任务、wait_member 取回复），再重试 set_product_stage。',
  ].join('\n')
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
    ...formatProductStageNextMoves(state),
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
