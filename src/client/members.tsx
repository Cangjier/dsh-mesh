/**
 * The Session-panel section for the member conversations of one Session.
 *
 * A main conversation that delegated through `call_member` tracks several
 * member conversations on other machines. The section lists them beside the
 * environment block and the subagent catalog: identity, state, member and
 * workspace per row, a click-open detail view, and the count beside the title.
 *
 * The facts come from the host's `/api/dsh-mesh/member-conversations`, which
 * reads the same task table and scope store the tools use; the browser never
 * touches the task records directly.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  ConfigProvider,
  Descriptions,
  Modal,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme as antdTheme,
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useThemeMode } from './theme'

/** Same-origin read of one Session's member conversations. */
export const MEMBER_CONVERSATIONS_PATH = '/api/dsh-mesh/member-conversations'

/** How often the section refreshes while the page is visible. */
const POLL_MS = 10_000

/** Rows shown before the fold control, matching the subagent section's budget. */
const FOLD_LIMIT = 5

/** One member conversation, as the host renders it. */
export interface MemberConversationRow {
  conversationId: string
  member: string
  memberIp: string
  memberName: string | null
  memberLabel: string
  workspace: string
  identity: string | null
  scope: string | null
  note: string | null
  compressPercent: number | null
  status: string
  statusLabel: string
  turns: number | null
  createdAt: string | null
  updatedAt: string | null
  lastSentAt: string | null
  prompt: string
}

interface Snapshot {
  total: number
  running: number
  rows: MemberConversationRow[]
}

interface Store {
  snapshot: Snapshot | null
  listeners: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
}

/** One poller per Session, shared by the section and its title-side count. */
const stores = new Map<string, Store>()

/**
 * The store for one Session, created on first use.
 * @param sessionId main conversation id.
 * @returns the store.
 */
function storeOf(sessionId: string): Store {
  let entry = stores.get(sessionId)
  if (entry === undefined) {
    entry = { snapshot: null, listeners: new Set(), timer: null }
    stores.set(sessionId, entry)
  }
  return entry
}

/**
 * Read one Session's member conversations and publish the result.
 *
 * A failed read keeps the last successful snapshot: a transient host error
 * must not make the section disappear or report stale states as empty.
 * @param sessionId main conversation id.
 * @returns when every listener ran.
 */
async function load(sessionId: string): Promise<void> {
  const entry = storeOf(sessionId)
  try {
    const response = await fetch(`${MEMBER_CONVERSATIONS_PATH}?session=${encodeURIComponent(sessionId)}`, {
      credentials: 'same-origin',
    })
    if (response.ok) {
      const body = await response.json() as { total?: number, running?: number, conversations?: MemberConversationRow[] }
      const rows = Array.isArray(body.conversations) ? body.conversations : []
      entry.snapshot = {
        total: typeof body.total === 'number' ? body.total : rows.length,
        running: typeof body.running === 'number' ? body.running : 0,
        rows,
      }
    }
  } catch {
    // Keep the previous snapshot; the next poll retries.
  }
  for (const listener of [...entry.listeners]) listener()
}

/**
 * Follow one Session's member conversations.
 *
 * The first mount starts the poller; the last unmount stops it, so an unread
 * section costs nothing.
 * @param sessionId main conversation id.
 * @returns the latest snapshot, or null before the first successful read.
 */
function useMemberConversations(sessionId: string): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => stores.get(sessionId)?.snapshot ?? null)
  useEffect(() => {
    const entry = storeOf(sessionId)
    const listener = (): void => setSnapshot(entry.snapshot)
    listener()
    entry.listeners.add(listener)
    if (entry.timer === null) {
      entry.timer = setInterval(() => {
        if (document.visibilityState !== 'hidden') void load(sessionId)
      }, POLL_MS)
      void load(sessionId)
    }
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size === 0 && entry.timer !== null) {
        clearInterval(entry.timer)
        entry.timer = null
        stores.delete(sessionId)
      }
    }
  }, [sessionId])
  return snapshot
}

/** The section's own styles: the panel has no stylesheet of ours. */
const SECTION_CSS = `
.dsh-mesh-members {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dsh-mesh-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.dsh-mesh-row:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-mesh-row-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dsh-mesh-row-identity {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-mesh-row-meta {
  font-size: 11px;
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-mesh-more {
  align-self: flex-start;
  padding: 4px 6px;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.dsh-mesh-more:hover {
  opacity: 1;
}
.dsh-mesh-progress {
  font-size: 12px;
  opacity: 0.6;
  white-space: nowrap;
}
.dsh-mesh-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.dsh-mesh-detail-member + .dsh-mesh-detail-member {
  margin-top: 12px;
}
`

/**
 * The status tag for one conversation.
 * @param status task state.
 * @param label localized label.
 * @returns the tag.
 */
function StatusTag({ status, label }: { status: string, label: string }) {
  const color = status === 'running' || status === 'starting'
    ? 'processing'
    : status === 'failed' || status === 'interrupted' ? 'error' : 'default'
  return <Tag color={color} style={{ marginInlineEnd: 0 }}>{label}</Tag>
}

/**
 * One detail block: every fact the host knows about a member conversation.
 * @param props row.
 * @returns the block.
 */
function MemberDetail({ row }: { row: MemberConversationRow }) {
  const member = row.memberName !== null && row.memberName !== '' ? row.memberName : row.member
  const updated = row.updatedAt === null ? null : new Date(row.updatedAt)
  return (
    <div className="dsh-mesh-detail-member">
      <Space size={8} wrap style={{ marginBottom: 6 }}>
        <Typography.Text strong>{row.identity ?? '未设置身份'}</Typography.Text>
        <StatusTag status={row.status} label={row.statusLabel} />
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>成员 {row.memberLabel}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.workspace}</Typography.Text>
      </Space>
      <Descriptions
        size="small"
        bordered
        column={1}
        styles={{ label: { width: 84, whiteSpace: 'nowrap' }, content: { minWidth: 0 } }}
        items={[
          { key: 'identity', label: '身份', children: row.identity ?? '未设置' },
          { key: 'workspace', label: '工作区', children: <span className="dsh-mesh-mono">{row.workspace}</span> },
          {
            key: 'member',
            label: '所属成员',
            children: `${row.memberLabel}（${member}${row.memberIp === '' ? '' : ` · ${row.memberIp}`}）`,
          },
          { key: 'scope', label: '工作范围', children: row.scope ?? '未设置' },
          { key: 'status', label: '状态', children: <StatusTag status={row.status} label={row.statusLabel} /> },
          {
            key: 'turns',
            label: '轮次',
            children: row.turns === null || row.turns <= 0 ? '—' : `第 ${String(row.turns)} 轮`,
          },
          {
            key: 'conversation',
            label: '会话 id',
            children: <span className="dsh-mesh-mono">{row.conversationId}</span>,
          },
          ...(row.compressPercent === null
            ? []
            : [{ key: 'compress', label: '压缩阈值', children: `${String(row.compressPercent)}%` }]),
          ...(row.note === null ? [] : [{ key: 'note', label: '备注', children: row.note }]),
          ...(updated === null
            ? []
            : [{ key: 'updated', label: '最近更新', children: updated.toLocaleString() }]),
          ...(row.prompt === ''
            ? []
            : [{
                key: 'prompt',
                label: '最初任务',
                children: <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{row.prompt}</Typography.Paragraph>,
              }]),
        ]}
      />
    </div>
  )
}

/**
 * The section body: one row per tracked member conversation.
 *
 * Five rows show at first, matching the subagent section; the rest sit behind
 * a fold. Clicking a row opens that conversation's detail. Nothing renders
 * while the Session tracks no conversation, which also hides the section.
 * @param props slot props (`sessionId`) and the client context.
 * @returns the section body, or null with nothing to show.
 */
export function MemberConversationsSection({ sessionId, ctx }: { sessionId: string, ctx: any }) {
  const mode = useThemeMode(ctx)
  const snapshot = useMemberConversations(sessionId)
  const [selected, setSelected] = useState<string | null>(null)
  const [unfolded, setUnfolded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load(sessionId)
    } finally {
      setRefreshing(false)
    }
  }, [sessionId])

  if (snapshot === null || snapshot.rows.length === 0) return null
  const { rows } = snapshot
  const shown = unfolded ? rows : rows.slice(0, FOLD_LIMIT)
  const selectedRow = rows.find(row => row.conversationId === selected) ?? null
  return (
    <ConfigProvider theme={{ algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>
      <style>{SECTION_CSS}</style>
      <div className="dsh-mesh-members">
        {shown.map(row => (
          <button
            key={row.conversationId}
            type="button"
            className="dsh-mesh-row"
            title={`${row.identity ?? '未设置身份'} · ${row.workspace}`}
            onClick={() => setSelected(row.conversationId)}
          >
            <span className="dsh-mesh-row-main">
              <span className="dsh-mesh-row-identity">{row.identity ?? '未设置身份'}</span>
              <span className="dsh-mesh-row-meta">{`成员 ${row.memberLabel} · ${row.workspace}`}</span>
            </span>
            <StatusTag status={row.status} label={row.statusLabel} />
          </button>
        ))}
        {rows.length > FOLD_LIMIT
          ? (
            <button type="button" className="dsh-mesh-more" onClick={() => setUnfolded(value => !value)}>
              {unfolded ? '收起' : `显示其余 ${String(rows.length - FOLD_LIMIT)} 个`}
            </button>
          )
          : null}
      </div>
      <Modal
        open={selectedRow !== null}
        title={`成员对话 · ${selectedRow?.identity ?? selectedRow?.conversationId ?? ''}`}
        width={720}
        onCancel={() => setSelected(null)}
        footer={(
          <Space>
            <Tooltip title="从这台 DSH 重新读取成员会话状态">
              <span>
                <Typography.Link onClick={() => { void refresh() }}>
                  <ReloadOutlined spin={refreshing} /> 刷新
                </Typography.Link>
              </span>
            </Tooltip>
            <Typography.Link onClick={() => setSelected(null)}>关闭</Typography.Link>
          </Space>
        )}
        destroyOnHidden
      >
        {selectedRow === null ? null : <MemberDetail row={selectedRow} />}
      </Modal>
    </ConfigProvider>
  )
}

/**
 * The count beside the section title: every conversation and the running ones.
 * @param props slot props (`sessionId`).
 * @returns the phrase, or null when the Session tracks none.
 */
export function MemberConversationsProgress({ sessionId }: { sessionId: string }) {
  const snapshot = useMemberConversations(sessionId)
  if (snapshot === null || snapshot.rows.length === 0) return null
  const { total, running } = snapshot
  return <span className="dsh-mesh-progress">{`${String(total)} 个${running > 0 ? ` · ${String(running)} 进行中` : ' · 全部空闲'}`}</span>
}
