/**
 * The `.coder/members/all.md` roster and the conversations it expects.
 *
 * A main conversation that keeps a member roster has one workspace per role.
 * The roster is the human record of who must exist; the member task table is
 * what actually exists. This module reads the roster and reports the members
 * that have no conversation yet, so the `[成员上下文]` snapshot and the
 * dispatch push can say so instead of silently leaving them out.
 *
 * A member whose named host is offline (or has no DSH) is excused: the roster
 * is still correct, the mesh just cannot create that conversation right now.
 * The same goes for every member when no host at all can create one.
 *
 * @module @local/dsh-mesh/member-roster
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { memberTaskProfile, memberTaskWorkspace } from './member-tasks.mjs'

/** Where the roster lives inside a project. */
export const MEMBER_ROSTER_PATH = path.join('.coder', 'members', 'all.md')

/** The fields one roster block may carry. */
const FIELD = /^(工作区名称|身份|工作范围|备注)\s*[：:]\s*(.*)$/u

/** `宿主 10.66.66.3` / `host HOSTNAME` inside a note. */
const HOST_IN_NOTE = /(?:宿主|主机|host)\s*[：:]?\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[A-Za-z0-9][A-Za-z0-9._-]*)/iu

/**
 * The host an entry names in its note, or null.
 * @param {string|null} note roster note.
 * @returns {string|null} address or hostname.
 */
export function memberRosterHost(note) {
  if (typeof note !== 'string' || note.trim() === '') return null
  const match = HOST_IN_NOTE.exec(note)
  return match === null ? null : match[1]
}

/**
 * Parse one roster document.
 *
 * The document starts with `# 主对话` and continues with zero or more
 * `# 成员N` blocks; a block without a workspace name is ignored because it
 * cannot identify a conversation.
 * @param {string} text roster markdown.
 * @returns {{main: {identity: string|null, scope: string|null}|null, members: object[]}} parsed roster.
 */
export function parseMemberRoster(text) {
  const members = []
  let main = null
  let current = null
  const flush = () => {
    if (current === null) return
    if (current.kind === 'main') {
      main = { identity: current.identity, scope: current.scope }
    } else if (current.workspace !== null) {
      members.push({
        title: current.title,
        workspace: current.workspace,
        identity: current.identity,
        scope: current.scope,
        note: current.note,
        host: memberRosterHost(current.note),
      })
    }
    current = null
  }
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const heading = /^#\s+(.+?)\s*$/u.exec(line)
    if (heading !== null) {
      flush()
      const title = heading[1]
      current = {
        kind: title.startsWith('主对话') ? 'main' : 'member',
        title,
        workspace: null,
        identity: null,
        scope: null,
        note: null,
      }
      continue
    }
    if (current === null) continue
    const field = FIELD.exec(line)
    if (field === null) continue
    const value = field[2].trim()
    if (value === '') continue
    if (field[1] === '工作区名称') current.workspace = value
    else if (field[1] === '身份') current.identity = value
    else if (field[1] === '工作范围') current.scope = value
    else if (field[1] === '备注') current.note = value
  }
  flush()
  return { main, members }
}

/**
 * Read one project's roster, or null when it has none.
 * @param {string} cwd project directory.
 * @returns {Promise<{main: object|null, members: object[]}|null>} roster.
 */
export async function readMemberRoster(cwd) {
  const dir = typeof cwd === 'string' ? cwd.trim() : ''
  if (dir === '') return null
  let text
  try {
    text = await readFile(path.join(dir, MEMBER_ROSTER_PATH), 'utf8')
  } catch {
    return null
  }
  const roster = parseMemberRoster(text)
  return roster.members.length === 0 ? null : roster
}

/**
 * Whether one member row can still create conversations.
 * @param {object} row member row.
 * @returns {boolean} true when it is online and runs DSH.
 */
export function memberHostUsable(row) {
  if (row === null || typeof row !== 'object') return false
  return row.online !== false && row.dsh === true
}

/**
 * The names one member row answers to.
 * @param {object} row member row.
 * @returns {string[]} id / name / address values.
 */
function hostNames(row) {
  return [row.id, row.name, row.ip, row.hostname]
    .filter(value => typeof value === 'string' && value !== '')
}

/**
 * The roster members that have no conversation, and the ones excused by a host.
 *
 * A member is covered when a tracked conversation uses its workspace name, or
 * (for a record created before workspace names were recorded) carries its
 * identity. An entry that names a host is excused when that host is missing
 * from the mesh or cannot create conversations; an entry without a host is
 * excused only when no host at all can create one.
 * @param {{members: object[]}|null} roster parsed roster.
 * @param {object[]} tasks tracked conversations of this main conversation.
 * @param {Record<string, object>} [scopes] conversation id -> stored scope.
 * @param {{hosts?: object[]}} [options] member rows; an empty list means "cannot tell".
 * @returns {{total: number, missing: object[], excused: {member: object, reason: string}[]}|null} gaps.
 */
export function memberRosterGaps(roster, tasks, scopes = {}, options = {}) {
  if (roster === null || roster === undefined || !Array.isArray(roster.members) || roster.members.length === 0) return null
  const hosts = Array.isArray(options.hosts) ? options.hosts.filter(row => row !== null && typeof row === 'object') : []
  const anyUsable = hosts.length === 0 ? true : hosts.some(memberHostUsable)
  const coveredWorkspaces = new Set()
  const coveredIdentities = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object' || task.archived === true) continue
    const workspace = memberTaskWorkspace(task)
    if (workspace !== '' && workspace !== 'unknown') coveredWorkspaces.add(workspace)
    const stored = scopes[String(task.conversationId ?? '')]
    const profile = stored !== undefined ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task)
    if (typeof profile?.identity === 'string' && profile.identity !== '') coveredIdentities.add(profile.identity)
  }
  const missing = []
  const excused = []
  for (const member of roster.members) {
    if (coveredWorkspaces.has(member.workspace)) continue
    if (member.identity !== null && coveredIdentities.has(member.identity)) continue
    if (member.host !== null && hosts.length > 0) {
      const row = hosts.find(candidate => hostNames(candidate).includes(member.host))
      if (row === undefined) {
        excused.push({ member, reason: `宿主 ${member.host} 不在组网里` })
        continue
      }
      if (!memberHostUsable(row)) {
        excused.push({ member, reason: `宿主 ${member.host} 当前不可用（离线或没有在运行 DSH）` })
        continue
      }
      missing.push(member)
      continue
    }
    if (!anyUsable) {
      excused.push({ member, reason: '没有可以创建成员对话的主机' })
      continue
    }
    missing.push(member)
  }
  return { total: roster.members.length, missing, excused }
}

/**
 * The lines a snapshot or push adds for the roster gaps.
 * @param {{total: number, missing: object[], excused: {member: object, reason: string}[]}|null} gaps gaps.
 * @returns {string[]} lines, empty when there is nothing to say.
 */
export function formatMemberGapLines(gaps) {
  if (gaps === null || gaps === undefined) return []
  const lines = []
  if (Array.isArray(gaps.missing) && gaps.missing.length > 0) {
    lines.push(`[成员缺口] .coder/members/all.md 记录了 ${String(gaps.total)} 个成员，其中 ${String(gaps.missing.length)} 个还没有成员对话（每个成员都必须有一个）：`)
    for (const member of gaps.missing) {
      const identity = member.identity === null ? '' : `, "identity": ${JSON.stringify(member.identity)}`
      lines.push(`- ${member.title}（工作区 ${member.workspace}${member.identity === null ? '' : `，身份 ${member.identity}`}）还没有成员对话：call_member { "workspace": ${JSON.stringify(member.workspace)}${identity} }，工作范围按名册里的写。`)
    }
  }
  if (Array.isArray(gaps.excused) && gaps.excused.length > 0) {
    lines.push(`[成员缺口] 名册里 ${String(gaps.excused.length)} 个成员暂时建不了对话：${gaps.excused.map(entry => `${entry.member.title}（${entry.reason}）`).join('、')}。`)
  }
  return lines
}
