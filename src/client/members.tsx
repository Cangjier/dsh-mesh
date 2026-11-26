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

import { useEffect, useState } from 'react'
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

/** One member conversation, as the host renders it. */
export interface MemberConversationRow {
  conversationId: string
  member: string
  memberIp: string
  memberName: string | null
  memberLabel: string
  workspace: string
  /** Standard identity (产品经理 / 研究员 / 开发 / 测试 / 业务), when set. */
  role: string | null
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
  /** The latest task the initiator dispatched (without the member preamble). */
  lastTask: string
}

interface Snapshot {
  total: number
  running: number
  rows: MemberConversationRow[]
}

/**
 * Per-Session section state: the last read, the view, and what the reader folded.
 *
 * It lives outside React so re-entering the Session (or remounting the panel)
 * paints the last list immediately instead of waiting for another request,
 * the way the subagent catalog reads its already-loaded projections.
 */
interface SectionState {
  snapshot: Snapshot | null
  /** The whole section body is folded away. */
  collapsed: boolean
  /** Group titles whose rows are folded away. */
  closedGroups: ReadonlySet<string>
  /** `grouped` lists every conversation by role; `running` is a flat running-only list. */
  view: 'grouped' | 'running'
}

interface Store {
  state: SectionState
  listeners: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
}

/** One store per Session; kept after unmount so the next entry is instant. */
const stores = new Map<string, Store>()

/**
 * The store for one Session, created on first use.
 * @param sessionId main conversation id.
 * @returns the store.
 */
function storeOf(sessionId: string): Store {
  let entry = stores.get(sessionId)
  if (entry === undefined) {
    entry = {
      state: { snapshot: null, collapsed: false, closedGroups: new Set(), view: 'grouped' },
      listeners: new Set(),
      timer: null,
    }
    stores.set(sessionId, entry)
  }
  return entry
}

/**
 * Replace one store's state and wake every listener.
 * @param entry store.
 * @param patch fields to change.
 * @returns nothing.
 */
function update(entry: Store, patch: Partial<SectionState>): void {
  entry.state = { ...entry.state, ...patch }
  for (const listener of [...entry.listeners]) listener()
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
      update(entry, {
        snapshot: {
          total: typeof body.total === 'number' ? body.total : rows.length,
          running: typeof body.running === 'number' ? body.running : 0,
          rows,
        },
      })
    }
  } catch {
    // Keep the previous snapshot; the next poll retries.
  }
}

/**
 * Follow one Session's member conversations and view state.
 *
 * The first mount starts the poller; the last unmount stops it. The store
 * itself stays, so the section paints its last list without a round trip.
 * @param sessionId main conversation id.
 * @returns current state and the actions the section and its header need.
 */
function useMemberSection(sessionId: string): {
  state: SectionState
  toggleCollapsed: () => void
  toggleGroup: (title: string) => void
  setView: (view: 'grouped' | 'running') => void
  refresh: () => Promise<void>
} {
  const [state, setState] = useState<SectionState>(() => storeOf(sessionId).state)
  useEffect(() => {
    const entry = storeOf(sessionId)
    const listener = (): void => setState(entry.state)
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
      }
    }
  }, [sessionId])
  return {
    state,
    toggleCollapsed: () => {
      update(storeOf(sessionId), { collapsed: !storeOf(sessionId).state.collapsed })
    },
    toggleGroup: (title) => {
      const entry = storeOf(sessionId)
      const closed = new Set(entry.state.closedGroups)
      if (closed.has(title)) closed.delete(title)
      else closed.add(title)
      update(entry, { closedGroups: closed })
    },
    setView: (view) => {
      update(storeOf(sessionId), { view })
    },
    refresh: async () => {
      await load(sessionId)
    },
  }
}

/** The section's own styles: the panel has no stylesheet of ours. */
const SECTION_CSS = `
.dsh-mesh-members {
  display: flex;
  flex-direction: column;
  gap: 0;
}
/* Folded away: an empty marker keeps the section (and its chevron) alive. */
.dsh-mesh-collapsed {
  height: 0;
}
.dsh-mesh-view {
  display: inline-flex;
  gap: 7px;
  font-size: 11px;
}
.dsh-mesh-view button {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.42;
  font: inherit;
  cursor: pointer;
}
.dsh-mesh-view button:hover {
  opacity: 0.7;
}
.dsh-mesh-view button[data-active] {
  opacity: 0.85;
  font-weight: 500;
}
.dsh-mesh-empty {
  padding: 2px 8px 4px;
  font-size: 11px;
  opacity: 0.45;
}
.dsh-mesh-group + .dsh-mesh-group {
  margin-top: 2px;
}
.dsh-mesh-group-title {
  display: grid;
  grid-template-columns: 1ch minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 4px;
  width: 100%;
  padding: 2px 8px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 500;
  opacity: 0.5;
}
.dsh-mesh-group-title:hover {
  opacity: 0.8;
}
.dsh-mesh-chevron {
  font-size: 9px;
}
.dsh-mesh-group-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-mesh-group-count {
  font-variant-numeric: tabular-nums;
}
.dsh-mesh-row {
  display: grid;
  grid-template-columns: 6px minmax(0, 1fr);
  align-items: center;
  column-gap: 7px;
  width: 100%;
  padding: 3px 8px 3px 2ch;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.dsh-mesh-row:hover {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.dsh-mesh-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  /* Idle: a hollow ring, like the subagent catalog's untouched rows. */
  background: transparent;
  box-shadow: inset 0 0 0 1.5px currentColor;
  opacity: 0.45;
}
.dsh-mesh-dot[data-status="running"],
.dsh-mesh-dot[data-status="starting"] {
  background: #1677ff;
  box-shadow: none;
  opacity: 1;
  animation: dsh-mesh-dot-pulse 1.4s ease-in-out infinite;
}
.dsh-mesh-dot[data-status="completed"] {
  background: #52c41a;
  box-shadow: none;
  opacity: 0.75;
}
.dsh-mesh-dot[data-status="failed"],
.dsh-mesh-dot[data-status="interrupted"] {
  background: #e5484d;
  box-shadow: none;
  opacity: 0.85;
}
@keyframes dsh-mesh-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.dsh-mesh-row-identity {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-mesh-progress {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  opacity: 0.55;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.dsh-mesh-fold {
  padding: 0 1px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 10px;
  opacity: 0.7;
}
.dsh-mesh-fold:hover {
  opacity: 1;
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
 * The role a conversation belongs to: its identity without the trailing number.
 *
 * `内核开发4` and `内核开发1` share 内核开发, `测试1` groups under 测试, and a
 * conversation without an identity is listed under its own placeholder rather
 * than dropped. This is the grouping the roster uses in prose ("测试", "内核
 * 开发"), derived from the identity so no second field is needed.
 * @param row conversation row.
 * @returns group title.
 */
function memberGroupOf(row: MemberConversationRow): string {
  const identity = typeof row.identity === 'string' ? row.identity.trim() : ''
  if (identity === '') return '未设置身份'
  const stripped = identity.replace(/[\s\d]+$/u, '').trim()
  return stripped === '' ? identity : stripped
}

/**
 * How many conversations of one group are running right now.
 * @param rows conversations of one role.
 * @returns running (or starting) count.
 */
function groupRunning(rows: MemberConversationRow[]): number {
  return rows.filter(row => row.status === 'running' || row.status === 'starting').length
}

/**
 * Group rows by role, keeping the order in which each role first appeared.
 * @param rows conversation rows.
 * @returns one entry per role.
 */
function groupRows(rows: MemberConversationRow[]): Array<{ title: string, rows: MemberConversationRow[] }> {
  const groups = new Map<string, MemberConversationRow[]>()
  for (const row of rows) {
    const title = memberGroupOf(row)
    const list = groups.get(title)
    if (list === undefined) groups.set(title, [row])
    else list.push(row)
  }
  return [...groups].map(([title, list]) => ({ title, rows: list }))
}

/** Characters shown before the task text offers its full view. */
const TASK_PREVIEW_CHARS = 200

/**
 * One task text: inline when short, otherwise a truncated line plus a toggle.
 *
 * A dispatched task can be thousands of characters (a review, a discussion);
 * the detail view keeps it scannable and opens the full text on request.
 * @param props the task text.
 * @returns the text.
 */
function TaskText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  if (text.length <= TASK_PREVIEW_CHARS) {
    return <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
  }
  return (
    <span style={{ whiteSpace: 'pre-wrap' }}>
      {expanded ? text : `${text.slice(0, TASK_PREVIEW_CHARS)}…`}
      {' '}
      <Typography.Link
        style={{ fontSize: 12, whiteSpace: 'nowrap' }}
        onClick={() => setExpanded(value => !value)}
      >
        {expanded ? '收起' : '显示详情'}
      </Typography.Link>
    </span>
  )
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
          { key: 'role', label: '标准身份', children: row.role ?? '未设置' },
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
          ...(row.lastTask === ''
            ? []
            : [{ key: 'task', label: '最近任务', children: <TaskText text={row.lastTask} /> }]),
        ]}
      />
    </div>
  )
}

/**
 * One group heading: the role, its running/total count, and a fold toggle.
 * @param props group title, counts, folded state and the toggle.
 * @returns the heading button.
 */
function GroupHeading({ title, running, total, folded, onToggle }: {
  title: string
  running: number
  total: number
  folded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="dsh-mesh-group-title"
      aria-expanded={!folded}
      title={`${folded ? '展开' : '折叠'} ${title}（${String(running)} 个进行中 / 共 ${String(total)} 个）`}
      onClick={onToggle}
    >
      <span className="dsh-mesh-chevron" aria-hidden="true">{folded ? '▸' : '▾'}</span>
      <span className="dsh-mesh-group-name">{title}</span>
      <span className="dsh-mesh-group-count">{`${String(running)}/${String(total)}`}</span>
    </button>
  )
}

/**
 * The section body: the member conversations of one Session.
 *
 * Two views: `grouped` lists every conversation under its role (folding on
 * either level), `running` is a flat list of the conversations running right
 * now. The reader's folds, view and last list live in the shared store, so
 * re-entering the Session paints the previous state immediately.
 * @param props slot props (`sessionId`) and the client context.
 * @returns the section body, or null with nothing to show.
 */
export function MemberConversationsSection({ sessionId, ctx }: { sessionId: string, ctx: any }) {
  const mode = useThemeMode(ctx)
  const { state, toggleCollapsed, toggleGroup, setView } = useMemberSection(sessionId)
  const [selected, setSelected] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await load(sessionId)
    } finally {
      setRefreshing(false)
    }
  }

  const snapshot = state.snapshot
  if (snapshot === null || snapshot.rows.length === 0) return null
  const { rows } = snapshot
  const selectedRow = rows.find(row => row.conversationId === selected) ?? null
  const renderRow = (row: MemberConversationRow) => (
    <button
      key={row.conversationId}
      type="button"
      className="dsh-mesh-row"
      title={`${row.identity ?? '未设置身份'} · ${row.workspace} · ${row.statusLabel}`}
      onClick={() => setSelected(row.conversationId)}
    >
      <span className="dsh-mesh-dot" data-status={row.status} title={row.statusLabel} aria-label={row.statusLabel} />
      <span className="dsh-mesh-row-identity">{row.identity ?? '未设置身份'}</span>
    </button>
  )
  const runningRows = rows.filter(row => row.status === 'running' || row.status === 'starting')
  // A single conversation has nothing to group; two or more group by role.
  const groups = rows.length > 1 ? groupRows(rows) : []
  return (
    <ConfigProvider theme={{ algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>
      <style>{SECTION_CSS}</style>
      {state.collapsed
        // An empty marker keeps the slot non-empty, so the panel keeps the
        // section title (and its expand control) instead of hiding it.
        ? <div className="dsh-mesh-collapsed" />
        : (
          <div className="dsh-mesh-members">
            {state.view === 'running'
              ? (runningRows.length === 0
                  ? <div className="dsh-mesh-empty">没有进行中的成员对话</div>
                  : runningRows.map(renderRow))
              : (groups.length === 0
                  ? rows.map(renderRow)
                  : groups.map((group) => {
                    const folded = state.closedGroups.has(group.title)
                    return (
                      <div key={group.title} className="dsh-mesh-group">
                        <GroupHeading
                          title={group.title}
                          running={groupRunning(group.rows)}
                          total={group.rows.length}
                          folded={folded}
                          onToggle={() => toggleGroup(group.title)}
                        />
                        {folded ? null : group.rows.map(renderRow)}
                      </div>
                    )
                  }))}
          </div>
        )}
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
 * The count and fold control beside the section title.
 *
 * The count is running over total, matching each group heading; the chevron
 * folds the whole list away while leaving the title (and this control) in
 * place.
 * @param props slot props (`sessionId`).
 * @returns the phrase and control, or null when the Session tracks none.
 */
export function MemberConversationsProgress({ sessionId }: { sessionId: string }) {
  const { state, toggleCollapsed, setView } = useMemberSection(sessionId)
  const snapshot = state.snapshot
  if (snapshot === null || snapshot.rows.length === 0) return null
  return (
    <span className="dsh-mesh-progress">
      <button
        type="button"
        className="dsh-mesh-fold"
        aria-expanded={!state.collapsed}
        title={state.collapsed ? '展开' : '折叠'}
        onClick={() => toggleCollapsed()}
      >
        {state.collapsed ? '▸' : '▾'}
      </button>
      <span className="dsh-mesh-view" role="group" aria-label="成员视图">
        <button
          type="button"
          data-active={state.view === 'grouped' ? '' : undefined}
          title="按角色分组"
          onClick={() => setView('grouped')}
        >
          分组
        </button>
        <button
          type="button"
          data-active={state.view === 'running' ? '' : undefined}
          title="平铺，只显示进行中的成员"
          onClick={() => setView('running')}
        >
          平铺
        </button>
      </span>
      <span title={`${String(snapshot.running)} 个进行中 / 共 ${String(snapshot.total)} 个`}>
        {`${String(snapshot.running)}/${String(snapshot.total)}`}
      </span>
    </span>
  )
}
