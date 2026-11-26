/**
 * The conversation-header entry for the member conversations of one Session.
 *
 * A main conversation that delegated through `call_member` tracks several
 * member conversations on other machines. This entry is the one place that
 * shows them without leaving the conversation: a compact "[icon] N个成员对话"
 * chip, a hover list (identity, status, member), and a click-open detail view.
 *
 * The facts come from the host's `/api/dsh-mesh/member-conversations`, which
 * reads the same task table and scope store the tools use; the browser never
 * touches the task records directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ConfigProvider,
  Descriptions,
  Empty,
  Modal,
  Popover,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme as antdTheme,
} from 'antd'
import { ApartmentOutlined, ReloadOutlined } from '@ant-design/icons'
import { useThemeMode } from './theme'

/** Same-origin read of one Session's member conversations. */
export const MEMBER_CONVERSATIONS_PATH = '/api/dsh-mesh/member-conversations'

/** How often the chip refreshes while the page is visible. */
const POLL_MS = 10_000

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
  error: string
}

/** The chip's own styles: the header seat has no panel stylesheet. */
const CHIP_CSS = `
.dsh-mesh-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-mesh-chip:hover,
.dsh-mesh-chip[aria-expanded="true"] {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-mesh-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #1677ff;
  animation: dsh-mesh-chip-pulse 1.4s ease-in-out infinite;
}
@keyframes dsh-mesh-chip-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.dsh-mesh-pop {
  max-width: 360px;
}
.dsh-mesh-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.dsh-mesh-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}
.dsh-mesh-pop-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  column-gap: 8px;
  row-gap: 1px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.dsh-mesh-pop-row:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.dsh-mesh-pop-identity {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-mesh-pop-meta {
  font-size: 11px;
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-mesh-detail-member + .dsh-mesh-detail-member {
  margin-top: 12px;
}
`

/**
 * Read one Session's member conversations.
 * @param sessionId the main conversation id.
 * @param signal abort signal for an unmounted component.
 * @returns the snapshot.
 */
async function readMemberConversations(sessionId: string, signal?: AbortSignal): Promise<Snapshot> {
  const response = await fetch(`${MEMBER_CONVERSATIONS_PATH}?session=${encodeURIComponent(sessionId)}`, {
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const body = await response.json() as Partial<Snapshot> & { conversations?: MemberConversationRow[] }
  const rows = Array.isArray(body.conversations) ? body.conversations : []
  return {
    total: typeof body.total === 'number' ? body.total : rows.length,
    running: typeof body.running === 'number' ? body.running : 0,
    rows,
    error: '',
  }
}

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
 * The chip plus its hover list and detail dialog.
 *
 * The chip is invisible until the host confirms at least one conversation, so
 * a Session that never delegated keeps a clean header.
 * @param props slot props (`sessionId`) and the client context.
 * @returns the entry, or nothing.
 */
export function MemberConversationsChip({ sessionId, ctx }: { sessionId: string, ctx: any }) {
  const mode = useThemeMode(ctx)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [details, setDetails] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await readMemberConversations(sessionId)
      if (alive.current) setSnapshot(next)
    } catch {
      // Keep the last known list: a transient host error must not make the
      // entry disappear or lie about the conversations.
      if (alive.current) setSnapshot(current => (current === null ? { total: 0, running: 0, rows: [], error: 'unavailable' } : current))
    }
  }, [sessionId])

  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh()
    }, POLL_MS)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const manualRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [refresh])

  if (snapshot === null || snapshot.rows.length === 0) return null

  const { total, running, rows } = snapshot
  const label = `${String(total)}个成员对话`
  const openDetails = (): void => {
    setDetails(true)
    void manualRefresh()
  }
  const content = (
    <div className="dsh-mesh-pop">
      <div className="dsh-mesh-pop-head">
        <Typography.Text strong>{label}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {running > 0 ? `${String(running)} 个进行中` : '全部空闲'}
        </Typography.Text>
      </div>
      {rows.map(row => (
        <button
          key={row.conversationId}
          type="button"
          className="dsh-mesh-pop-row"
          onClick={openDetails}
        >
          <span className="dsh-mesh-pop-identity">{row.identity ?? '未设置身份'}</span>
          <StatusTag status={row.status} label={row.statusLabel} />
          <span className="dsh-mesh-pop-meta">
            {`成员 ${row.memberLabel} · ${row.workspace}`}
          </span>
          <span />
        </button>
      ))}
      <div style={{ marginTop: 6, textAlign: 'right' }}>
        <Typography.Link onClick={openDetails} style={{ fontSize: 12 }}>查看详情</Typography.Link>
      </div>
    </div>
  )
  return (
    <ConfigProvider theme={{ algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>
      <style>{CHIP_CSS}</style>
      <Popover
        content={content}
        trigger="hover"
        placement="bottomRight"
        mouseEnterDelay={0.15}
        mouseLeaveDelay={0.2}
      >
        <button
          type="button"
          className="dsh-mesh-chip"
          aria-haspopup="dialog"
          title={label}
          onClick={openDetails}
        >
          <ApartmentOutlined />
          <span>{label}</span>
          {running > 0 ? <span className="dsh-mesh-chip-dot" aria-hidden="true" /> : null}
        </button>
      </Popover>
      <Modal
        open={details}
        title={`成员对话 · ${label}`}
        width={720}
        onCancel={() => setDetails(false)}
        footer={(
          <Space>
            <Tooltip title="从这台 DSH 重新读取成员会话状态">
              <span>
                <Typography.Link onClick={() => { void manualRefresh() }}>
                  <ReloadOutlined spin={refreshing} /> 刷新
                </Typography.Link>
              </span>
            </Tooltip>
            <Typography.Link onClick={() => setDetails(false)}>关闭</Typography.Link>
          </Space>
        )}
        destroyOnHidden
      >
        {rows.length === 0
          ? <Empty description="没有成员对话" />
          : rows.map(row => <MemberDetail key={row.conversationId} row={row} />)}
      </Modal>
    </ConfigProvider>
  )
}
