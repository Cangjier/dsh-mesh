/**
 * The member-conversation rows the Web client's header chip renders.
 *
 * The chip answers one question: which member conversations does this main
 * conversation currently track, who are they, and are they running? The host
 * keeps the facts in the member task table plus `member-scopes.json`; this
 * module turns one task record into the flat, JSON-safe row the browser needs,
 * so the client never has to know the task record's shape.
 *
 * @module @local/dsh-mesh/member-ui
 */

import { describeMemberTask, memberTaskProfile } from './member-tasks.mjs'

/** How much of the original prompt one detail row keeps. */
export const MEMBER_UI_PROMPT_MAX = 280

/**
 * The short member label a chip row shows.
 *
 * In this mesh a member is usually addressed by its VPN address, so the last
 * IPv4 octet ("3", "4") is the label an operator recognises; a member without
 * a usable address falls back to its name. The full name and address stay on
 * the row for the detail view.
 * @param {object} task task record.
 * @returns {string} short label, never empty.
 */
export function memberShortLabel(task) {
  const ip = String(task?.memberIp ?? '').trim()
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(ip)
  if (octets !== null) return octets[4]
  const name = String(task?.member ?? '').trim()
  return name === '' ? 'unknown' : name
}

/**
 * One conversation row for the chip and its detail view.
 *
 * A stored scope (`member-scopes.json`, keyed by conversation id) wins over the
 * task's profile snapshot, matching what `status_member` and the snapshot show.
 * @param {object} task task record.
 * @param {Record<string, object>} [scopes] conversation id -> stored scope.
 * @returns {object} JSON-safe row.
 */
export function memberConversationEntry(task, scopes = {}) {
  const entry = describeMemberTask(task)
  const stored = scopes[String(entry.conversationId ?? '')] ?? null
  const profile = stored !== null ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task)
  const note = typeof stored?.note === 'string' && stored.note.trim() !== '' ? stored.note.trim() : null
  const compressPercent = typeof stored?.compressPercent === 'number' && Number.isFinite(stored.compressPercent)
    ? stored.compressPercent
    : null
  const rawPrompt = typeof task?.prompt === 'string'
    ? task.prompt
    : typeof task?.lastPrompt === 'string' ? task.lastPrompt : ''
  return {
    conversationId: entry.conversationId,
    member: entry.member,
    memberIp: entry.memberIp,
    memberName: profile?.name ?? (entry.member === '' ? null : entry.member),
    memberLabel: memberShortLabel(task),
    workspace: entry.workspace,
    identity: profile?.identity ?? null,
    scope: profile?.scope ?? null,
    note,
    compressPercent,
    status: entry.status,
    statusLabel: entry.statusLabel,
    turns: entry.turns,
    createdAt: typeof task?.createdAt === 'string' ? task.createdAt : null,
    updatedAt: typeof task?.updatedAt === 'string' ? task.updatedAt : null,
    lastSentAt: typeof task?.lastSentAt === 'string' ? task.lastSentAt : null,
    prompt: rawPrompt.length > MEMBER_UI_PROMPT_MAX ? `${rawPrompt.slice(0, MEMBER_UI_PROMPT_MAX)}…` : rawPrompt,
  }
}

/**
 * Map every task of one origin conversation, preserving the caller's order.
 * @param {object[]} tasks task records, oldest first.
 * @param {Record<string, object>} [scopes] conversation id -> stored scope.
 * @returns {object[]} rows.
 */
export function memberConversationEntries(tasks, scopes = {}) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter(task => task !== null && typeof task === 'object')
    .map(task => memberConversationEntry(task, scopes))
}

/**
 * The chip's counts: every tracked conversation, and how many are running.
 * @param {object[]} entries rows from {@link memberConversationEntries}.
 * @returns {{total: number, running: number}} counts.
 */
export function memberConversationSummary(entries) {
  const list = Array.isArray(entries) ? entries : []
  return {
    total: list.length,
    running: list.filter(entry => entry?.status === 'running' || entry?.status === 'starting').length,
  }
}
