import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Collapse,
  ConfigProvider,
  Descriptions,
  Empty,
  Grid,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
  theme as antdTheme,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  DeleteOutlined,
  CloudDownloadOutlined,
  EditOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  ArrowUpOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import styles from './styles.css'
import { renderMarkdown } from './markdown'
import {
  api,
  ApiError,
  isStartingError,
  STARTING_MESSAGE,
  OFFLINE_MESSAGE,
  type ConversationGroup,
  type ConversationSnapshot,
  type DeployJob,
  type Member,
  type MemberConversation,
  type PackageInfo,
  type Snapshot,
  type SystemInfo,
} from './api'
import { WireGuardPanel } from './wireguard'
import { EN as WIREGUARD_EN, dictionary as wireguardDictionary } from './wireguard/i18n'

const NS = 'dsh-mesh'
const PANEL_ID = 'mesh'
const MEMBER_NAME_LIMIT = 12

/** Members show a short label in the table; the full name lives in the detail modal. */
function shortMemberName(name: string): string {
  const chars = Array.from(name)
  return chars.length > MEMBER_NAME_LIMIT ? `${chars.slice(0, MEMBER_NAME_LIMIT).join('')}…` : name
}

function useThemeMode(ctx: any): 'light' | 'dark' {
  const [snapshot, setSnapshot] = useState<any>(() => ctx.theme.getTheme())
  useEffect(() => ctx.on('theme/change', (next: any) => setSnapshot(next)), [ctx])
  return snapshot?.active?.colorScheme === 'dark' ? 'dark' : 'light'
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (isStartingError(error)) return error.message
    return `${error.message}（HTTP ${String(error.status)}）`
  }
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)} ${units[unit]}`
}

/**
 * The member's OS. A member without DSH cannot report its platform, so fall
 * back to a name hint (`VM-0-2-ubuntu`, `win-build`) instead of letting the
 * newest package decide and picking a Windows archive for Ubuntu.
 */
function preferredTarget(member: Member): 'linux' | 'windows' | undefined {
  const platform = member.system?.platform?.toLowerCase() ?? ''
  if (platform.startsWith('win')) return 'windows'
  if (platform !== '') return 'linux'
  const name = member.name.toLowerCase()
  if (/windows|(^|[-_.])win($|[-_.])/.test(name)) return 'windows'
  if (/ubuntu|debian|centos|alma|rocky|fedora|linux|suse|redhat/.test(name)) return 'linux'
  return undefined
}

/** The member's install root, straight from its system info when it is up. */
function memberAppRoot(member: Member | null): string {
  if (member === null) return ''
  const system = memberSystem(member)
  const root = system?.appRoot?.trim() ?? ''
  if (root !== '') return root
  const home = system?.home?.trim() ?? ''
  if (home === '') return ''
  const base = home.replace(/[\\/]+$/u, '')
  return system?.platform === 'win32' ? `${base}\\.dsh\\dsh-mesh` : `${base}/.dsh/dsh-mesh`
}

function formatGb(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 GB'
  const gb = value / 1024 ** 3
  return `${gb >= 100 ? String(Math.round(gb)) : gb.toFixed(1)} GB`
}

function memberSystem(member: Member): SystemInfo | null {
  return member.system ?? ((member.gate as { system?: SystemInfo } | null)?.system ?? null)
}

function systemText(member: Member): string {
  const system = memberSystem(member)
  if (system === null) return '—'
  const parts: string[] = []
  if (system.cpu !== undefined) {
    parts.push(`CPU ${String(system.cpu.cores ?? '?')}C ${String(system.cpu.usagePercent ?? 0)}%`)
  }
  if (system.memory !== undefined) {
    parts.push(`MEM ${String(system.memory.usedPercent ?? 0)}%`)
  }
  const disks = system.disks ?? []
  const root = disks.find(disk => disk.mount === '/' || disk.mount === 'C:\\') ?? disks[0]
  if (root !== undefined) {
    const free = root.availableBytes ?? root.freeBytes ?? Math.max(0, (root.totalBytes ?? 0) - (root.usedBytes ?? 0))
    parts.push(`${root.mount ?? 'disk'} ${formatGb(free)} 可用`)
  }
  return parts.length === 0 ? '—' : parts.join(' · ')
}

function systemDetails(member: Member): string {
  const system = memberSystem(member)
  if (system === null) return '未获取到系统信息'
  const lines: string[] = []
  if (system.cpu !== undefined) {
    lines.push(`${system.cpu.model ?? 'CPU'} · ${String(system.cpu.cores ?? '?')} 核 · ${String(system.cpu.usagePercent ?? 0)}%`)
  }
  if (system.memory !== undefined) {
    lines.push(`内存 ${formatBytes(system.memory.usedBytes ?? 0)} / ${formatBytes(system.memory.totalBytes ?? 0)} · ${String(system.memory.usedPercent ?? 0)}%`)
  }
  if (system.home !== undefined && system.home !== '') lines.push(`用户目录 ${system.home}`)
  if (system.appRoot !== undefined && system.appRoot !== '') lines.push(`部署目录 ${system.appRoot}`)
  if (system.user !== undefined && system.user !== '') lines.push(`运行用户 ${system.user}`)
  for (const disk of system.disks ?? []) {
    const free = disk.availableBytes ?? disk.freeBytes ?? Math.max(0, (disk.totalBytes ?? 0) - (disk.usedBytes ?? 0))
    lines.push(`${disk.mount ?? 'disk'} 可用 ${formatGb(free)} / 共 ${formatGb(disk.totalBytes ?? 0)} · 已用 ${String(disk.usedPercent ?? 0)}%`)
  }
  return lines.join('\n')
}

/** Map a deploy step state onto the antd Steps vocabulary. */
function stepStatus(status: string): 'wait' | 'process' | 'finish' | 'error' {
  if (status === 'running') return 'process'
  if (status === 'succeeded') return 'finish'
  if (status === 'failed') return 'error'
  return 'wait'
}

/** Human duration between two ISO timestamps; open intervals use "now". */
function durationText(from: string | null | undefined, to: string | null | undefined): string {
  if (from === null || from === undefined || from === '') return ''
  const start = Date.parse(from)
  const end = to !== null && to !== undefined && to !== '' ? Date.parse(to) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return ''
  const seconds = Math.max(0, (end - start) / 1000)
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))} 秒`
  return `${String(Math.floor(seconds / 60))} 分 ${String(Math.round(seconds % 60))} 秒`
}

/** Remaining upload time at the current speed. */
function etaText(speed: number, remaining: number): string {
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(remaining) || remaining <= 0) return ''
  const seconds = Math.ceil(remaining / speed)
  if (seconds < 60) return `剩余约 ${String(seconds)} 秒`
  return `剩余约 ${String(Math.floor(seconds / 60))} 分 ${String(seconds % 60)} 秒`
}

/** Detail view for one deployment: upload meter, steps, and log tail. */
/** Share of the whole job each step owns, so one number covers upload → live. */
const DEPLOY_STEP_SHARE: Record<string, [number, number]> = {
  upload: [0, 60],
  prepare: [60, 90],
  activate: [90, 100],
}

/**
 * Overall percentage of a deploy job.
 *
 * The job reports one meter whose label says what is being measured; the step
 * list says which share of the work is done, so the member table can show a
 * single number that never goes backwards.
 */
function deployPercent(job: DeployJob): number {
  if (job.status === 'succeeded') return 100
  const meter = job.progress
  const inner = typeof meter?.percent === 'number' ? Math.max(0, Math.min(100, meter.percent)) : 0
  if (job.status !== 'running') return Math.round(inner)
  const active = (job.steps ?? []).find(step => step.status === 'running')
  if (active === undefined) return 0
  const share = DEPLOY_STEP_SHARE[active.key]
  if (share === undefined) return Math.round(inner)
  const own = active.progress === undefined || active.progress === null ? inner : active.progress.percent
  return Math.round(share[0] + ((share[1] - share[0]) * Math.max(0, Math.min(100, own))) / 100)
}

function DeployProgressView({ job, lines }: { job: DeployJob; lines: string[] }) {
  // Older hosts returned the log as one string; never assume the array shape.
  const logLines = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/u)
  const progress = job.progress
  const total = progress?.totalBytes ?? 0
  const bytes = progress?.bytes ?? 0
  const speed = progress?.speed ?? 0
  const indeterminate = progress?.indeterminate === true
  const percent = indeterminate ? 100 : Math.max(0, Math.min(100, progress?.percent ?? 0))
  const running = job.status === 'running'
  // The meter is shared by the upload and the extraction: same bar, different
  // unit. `label` comes from the deploy engine, which is the only place that
  // knows which phase is running.
  const meters = progress?.total ?? 0
  const meterLabel = progress?.label ?? '上传安装包'
  const meterText = total > 0
    ? (indeterminate
      ? `已上传 ${formatBytes(bytes)} / ${formatBytes(total)}（服务器不支持流式上传，无法显示百分比）`
      : `${formatBytes(bytes)} / ${formatBytes(total)}${speed > 0 ? ` · ${formatBytes(speed)}/s` : ''}${etaText(speed, total - bytes)}`)
    : meters > 0 ? `已解压 ${progress?.done ?? 0} / ${meters} 项` : ''
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space size={8} wrap>
        {running
          ? <Tag color="processing">部署中 {deployPercent(job)}%</Tag>
          : job.status === 'succeeded'
            ? <Tag color="success">部署成功</Tag>
            : <Tag color="error">部署失败</Tag>}
        <Typography.Text type="secondary" className="dsh-pw-mono">{job.id}</Typography.Text>
        <Typography.Text type="secondary">
          {job.target.os === 'windows' ? 'Windows' : 'Linux'} · {job.target.host}
          {job.target.user !== null && job.target.user !== undefined && job.target.user !== '' ? `（${job.target.user}）` : ''}
        </Typography.Text>
      </Space>
      <Descriptions
        size="small"
        bordered
        column={1}
        styles={{ label: { width: 90, whiteSpace: 'nowrap' }, content: { minWidth: 0 } }}
        items={[
          { key: 'release', label: '发布版本', children: <span className="dsh-pw-mono">{job.release}</span> },
          { key: 'root', label: '安装目录', children: <span className="dsh-pw-mono">{job.target.appRoot}</span> },
          { key: 'created', label: '开始时间', children: new Date(job.createdAt).toLocaleString() },
        ]}
      />
      <div>
        <Typography.Text strong>{meterLabel}</Typography.Text>
        <Progress
          percent={percent}
          status={job.status === 'failed' ? 'exception' : percent >= 100 ? 'success' : 'active'}
          showInfo={!indeterminate}
        />
        {meterText === '' ? null : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{meterText}</Typography.Text>
        )}
      </div>
      <Steps
        direction="vertical"
        size="small"
        status={job.status === 'failed' ? 'error' : job.status === 'succeeded' ? 'finish' : 'process'}
        items={(job.steps ?? []).map(step => {
          const duration = durationText(step.startedAt, step.finishedAt)
          return {
            title: step.label,
            status: stepStatus(step.status),
            description: (
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {duration}
                  {step.detail !== '' ? `${duration === '' ? '' : ' · '}${step.detail}` : ''}
                </Typography.Text>
                {step.progress !== undefined && step.progress !== null ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {step.progress.done} / {step.progress.total} 项 · {step.progress.percent}%
                  </Typography.Text>
                ) : null}
              </Space>
            ),
          }
        })}
      />
      {job.status === 'failed' ? <Alert type="error" showIcon message="部署失败" description={job.error ?? '未知错误'} /> : null}
      {job.status === 'succeeded' ? <Alert type="success" showIcon message="部署完成" description={`健康检查通过，发布 ${job.release}`} /> : null}
      <div>
        <Typography.Text strong>日志</Typography.Text>
        <pre className="dsh-pw-deploy-log">{logLines.length > 0 ? logLines.slice(-200).join('\n') : '等待日志…'}</pre>
      </div>
    </Space>
  )
}

/** Badge colour for a conversation status reported by a member's interop service. */
function conversationStatusColor(status: string | undefined): string {
  switch (status) {
    case 'running': return 'processing'
    case 'idle': return 'success'
    case 'error':
    case 'unavailable': return 'error'
    case 'interrupted': return 'warning'
    case 'blank': return 'default'
    default: return 'default'
  }
}

/** What a conversation is about: its title, else the last answer, else its id. */
/** Palette for the member avatars; picked by address so it stays stable. */
const CHAT_AVATAR_COLORS = ['#5b8ff9', '#61ddaa', '#f6bd16', '#7262fd', '#78d3f8', '#f6903d', '#e8684a']

function chatAvatarColor(seed: string): string {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) % 100_000
  return CHAT_AVATAR_COLORS[hash % CHAT_AVATAR_COLORS.length] ?? '#5b8ff9'
}

/** Long enough to blow up the bubble: three lines or ~160 characters. */
function chatNeedsDetail(text: string): boolean {
  return text.length > 160 || text.split('\n').length > 3
}

function chatTime(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const now = Date.now()
  const delta = now - date.getTime()
  if (delta >= 0 && delta < 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString()
}

function conversationTitle(row: MemberConversation): string {
  const title = (row.title ?? '').trim()
  if (title !== '') return title
  const last = (row.lastText ?? '').trim()
  if (last !== '') return last
  return row.id.slice(0, 8)
}

interface ChatMessage {
  key: string
  /** true when the local member sent it, so it sits on the right. */
  out: boolean
  /** Avatar label: the last octet of the sender's mesh address. */
  number: string
  /** Mesh address of the sender, used to open the member's page. */
  senderIp: string
  /** Inline "@3" / "回复@1" prefix. */
  mention: string
  text: string
  /** Displayed clock time. */
  time: string
  /** ISO instant, kept apart because the displayed form does not sort. */
  sortKey: string
  status: string
  detailMeta: string
}

/** The mesh address ends in the number the chat calls a member by. */
function chatNumber(ip: string | undefined): string {
  const text = (ip ?? '').trim()
  const last = text.slice(text.lastIndexOf('.') + 1)
  return /^\d{1,3}$/.test(last) ? last : ''
}

/**
 * One conversation is one exchange: the initiator's prompt and the answer the
 * member's interop service produced. Both are addressed by number, so the whole
 * mesh reads as a single group chat instead of a per-member inbox.
 */
function conversationMessages(
  row: MemberConversation,
  group: ConversationGroup,
  selfNumber: string,
): ChatMessage[] {
  const status = row.status ?? ''
  const memberNumber = chatNumber(group.ip) === '' ? group.ip : chatNumber(group.ip)
  const initiatorNumber = chatNumber(row.initiator?.ip) === '' ? selfNumber : chatNumber(row.initiator?.ip)
  const meta = [row.id.slice(0, 8), status, row.turns === undefined ? '' : `${String(row.turns)} 轮`]
    .filter(part => part !== '')
    .join(' · ')
  const sentAt = chatTime(row.createdAt)
  const answeredAt = chatTime(row.updatedAt ?? row.createdAt)
  const sent: ChatMessage = {
    key: `${row.id}-out`,
    out: initiatorNumber === selfNumber,
    number: initiatorNumber,
    senderIp: (row.initiator?.ip ?? '') === '' ? group.ip : String(row.initiator?.ip ?? ''),
    mention: `@${memberNumber}`,
    text: conversationTitle(row),
    time: sentAt,
    sortKey: String(row.createdAt ?? ''),
    status,
    detailMeta: meta,
  }
  const answer = (row.lastText ?? '').trim()
  const reply = (text: string): ChatMessage => ({
    key: `${row.id}-in`,
    out: false,
    number: memberNumber,
    senderIp: group.ip,
    mention: `回复@${initiatorNumber}`,
    text,
    time: answeredAt,
    sortKey: String(row.updatedAt ?? row.createdAt ?? ''),
    status,
    detailMeta: meta,
  })
  if (answer !== '') return [sent, reply(answer)]
  if (status === 'running') return [sent, reply('正在处理…')]
  // The member's DSH restarted before the turn finished: the conversation is
  // still there, but this round produced nothing.
  if (status === 'interrupted') return [sent, reply('对话被中断（目标的 DSH 重启了），这一轮没有结果')]
  if (row.error !== null && row.error !== undefined && String(row.error) !== '') {
    return [sent, reply(String(row.error))]
  }
  return [sent]
}

function ChatBubble({ message, onDetail, onMember }: {
  message: ChatMessage
  onDetail: (message: ChatMessage) => void
  onMember: (ip: string) => void
}) {
  const truncatable = chatNeedsDetail(message.text)
  const pending = message.status === 'running' && message.out === false && message.text === '正在处理…'
  return (
    <div className={`chat-row ${message.out ? 'chat-row-out' : ''}`}>
      <button
        type="button"
        className="chat-avatar chat-avatar-button"
        style={{ background: message.out ? 'var(--chat-avatar-bg)' : chatAvatarColor(message.number) }}
        title={`查看成员 ${message.number} 的状态`}
        onClick={() => onMember(message.senderIp)}
      >
        {message.number}
      </button>
      <div className="chat-body">
        <div className={`chat-bubble ${message.out ? 'chat-bubble-out' : 'chat-bubble-in'}`}>
          <span className="chat-mention">{message.mention}</span>
          <span className={`chat-text ${truncatable ? 'chat-text-clamped' : ''}`}>
            {message.text}
          </span>
          {pending ? <Spin size="small" style={{ marginLeft: 8 }} /> : null}
        </div>
        <div className={`chat-foot ${message.out ? 'chat-foot-out' : ''}`}>
          {truncatable ? (
            <Button
              type="link"
              size="small"
              style={{ height: 'auto', padding: 0 }}
              onClick={() => onDetail(message)}
            >
              详细
            </Button>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{message.time}</Typography.Text>
        </div>
      </div>
    </div>
  )
}

/** What a member page shows: identity first, then the machine it runs on. */
function MemberStatus({ member }: { member: Member }) {
  const system = member.system ?? null
  const memory = system?.memory
  const disks = system?.disks ?? []
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions
        size="small"
        column={2}
        colon={false}
        items={[
          { key: 'name', label: '成员', children: member.name },
          { key: 'ip', label: '组网地址', children: member.ip },
          { key: 'online', label: '状态', children: member.online ? '在线' : '离线' },
          { key: 'latency', label: '延迟', children: member.latencyMs > 0 ? `${String(member.latencyMs)} ms` : '—' },
          { key: 'host', label: '主机名', children: system?.hostname ?? '—' },
          { key: 'platform', label: '系统', children: system?.platform ?? '—' },
          { key: 'arch', label: '架构', children: system?.arch ?? '—' },
          { key: 'user', label: '运行用户', children: system?.user ?? '—' },
          { key: 'appRoot', label: '安装目录', children: system?.appRoot ?? '—' },
          { key: 'tag', label: '标签', children: member.tag ?? '—' },
        ]}
      />
      {member.error !== null && member.error !== undefined && member.error !== '' ? (
        <Alert type="warning" showIcon message={member.error} />
      ) : null}
      {system === null ? (
        <Empty description="这个成员还没有上报系统信息" />
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>CPU</Typography.Text>
            <div>
              {system.cpu?.model ?? '—'}
              {system.cpu?.cores === undefined ? null : ` · ${String(system.cpu.cores)} 核`}
              {system.cpu?.usagePercent === undefined ? null : ` · 使用 ${String(Math.round(system.cpu.usagePercent))}%`}
            </div>
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>内存</Typography.Text>
            <div>
              {`${formatBytes(memory?.usedBytes ?? 0)} / ${formatBytes(memory?.totalBytes ?? 0)}`}
            </div>
            <Progress
              percent={Math.round(memory?.usedPercent ?? 0)}
              size="small"
              status={(memory?.usedPercent ?? 0) >= 90 ? 'exception' : 'normal'}
            />
          </div>
          {disks.map(disk => (
            <div key={String(disk.mount ?? '')}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{`磁盘 ${String(disk.mount ?? '')}`}</Typography.Text>
              <div>
                {`${formatBytes(disk.usedBytes ?? 0)} / ${formatBytes(disk.totalBytes ?? 0)}`}
              </div>
              <Progress
                percent={Math.round(disk.usedPercent ?? 0)}
                size="small"
                status={(disk.usedPercent ?? 0) >= 90 ? 'exception' : 'normal'}
              />
            </div>
          ))}
        </Space>
      )}
    </Space>
  )
}

/**
 * Every conversation in the mesh, merged into one group chat. Members are just
 * their mesh number (the last octet of 10.66.66.x), the local member sits on the
 * right, and each message says whom it is addressed to: "@3 …" out, "回复@1 …"
 * back.
 */
function MemberConversations({ active, members, refreshToken }: {
  active: boolean
  members: Member[]
  refreshToken: number
}) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<ChatMessage | null>(null)
  const [memberIp, setMemberIp] = useState('')
  const messagesRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await api.conversations())
      setError('')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Load once when the tab is opened; refreshing is a deliberate action, so a
    // running conversation is never rebuilt under the reader.
    if (!active) return undefined
    void load()
    return undefined
  }, [active, load, refreshToken])

  // Clicking the transcript reloads it. No spinner, no banner: the messages are
  // simply replaced when the answer arrives.
  const reloadOnClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    // 详细 and links have their own job; a text selection means the reader is
    // copying, not refreshing.
    if (target.closest('button, a') !== null) return
    if ((window.getSelection()?.toString() ?? '') !== '') return
    void load()
  }

  // Colours follow the DSH theme so the chat matches the surrounding app and
  // keeps working in dark mode; the CSS only owns the layout.
  const { token } = antdTheme.useToken()
  const chatColors = {
    '--chat-pane-bg': token.colorBgLayout,
    '--chat-surface': token.colorBgContainer,
    '--chat-list-bg': token.colorFillQuaternary,
    '--chat-list-hover': token.colorFillSecondary,
    '--chat-list-active': token.colorFill,
    '--chat-item-border': token.colorBorderSecondary,
    '--chat-in-bg': token.colorBgContainer,
    '--chat-in-border': token.colorBorderSecondary,
    '--chat-out-bg': token.colorPrimaryBg,
    '--chat-out-border': token.colorPrimaryBorder,
    '--chat-avatar-bg': token.colorPrimary,
    '--chat-text': token.colorText,
    '--chat-muted': token.colorTextTertiary,
  } as React.CSSProperties

  const groups: ConversationGroup[] = snapshot?.groups ?? []
  const selfNumber = chatNumber(groups.find(group => group.self)?.ip) || '1'
  const messages = useMemo(() => groups
    .flatMap(group => group.conversations.flatMap(row => conversationMessages(row, group, selfNumber)))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey)), [groups, selfNumber])

  // 详细 swaps the tab content for the full text. Both views stay mounted and
  // only their display changes, so returning lands where the reader left off.
  const transcriptScroll = useRef<number | null>(null)
  const scroller = (): HTMLElement | null =>
    (messagesRef.current?.closest<HTMLElement>('.ant-tabs-content-holder') ?? null)
  const openDetail = (message: ChatMessage) => {
    transcriptScroll.current = scroller()?.scrollTop ?? null
    setDetail(message)
  }
  const closeDetail = () => {
    setDetail(null)
    const holder = scroller()
    if (holder !== null && transcriptScroll.current !== null) holder.scrollTop = transcriptScroll.current
    transcriptScroll.current = null
  }

  // A chat opens at the newest message, like every messenger. Scrolling the
  // container (not the sentinel) keeps the composer, which sits below the
  // transcript, inside the viewport instead of just under it.
  useEffect(() => {
    const holder = messagesRef.current?.closest<HTMLElement>('.ant-tabs-content-holder') ?? null
    if (holder !== null) holder.scrollTop = holder.scrollHeight
  }, [messages])

  /** The member shown by an avatar click, resolved from the panel's snapshot. */
  const member = memberIp === '' ? null : members.find(entry => entry.ip === memberIp) ?? null

  // ---- composer ----
  // A message typed here becomes a conversation on the member, so `@3` routes
  // to one machine and a message without a mention goes to all of them.
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null)
  const draftRef = useRef<HTMLTextAreaElement | null>(null)

  // Self is not a target: the panel already shows its own side of the chat.
  const roster = useMemo(() => members
    .filter(entry => entry.kind !== 'self' && (entry.ip ?? '') !== '')
    .map(entry => ({ member: entry, number: chatNumber(entry.ip) }))
    .filter(entry => entry.number !== '')
    .sort((left, right) => Number(left.number) - Number(right.number)), [members])

  const suggestions = useMemo(() => {
    if (mention === null) return []
    const query = mention.query.toLowerCase()
    return roster.filter(entry => query === ''
      || entry.number.startsWith(query)
      || entry.member.name.toLowerCase().includes(query))
  }, [mention, roster])

  /** The `@` fragment the caret sits in, if any. */
  const mentionAt = (value: string, caret: number) => {
    const match = /@([^\s@]*)$/u.exec(value.slice(0, caret))
    if (match === null) return null
    const query = match[1] ?? ''
    return { query, start: caret - query.length - 1 }
  }

  /** Insert an `@` at the caret and open the picker, like the `+` slot. */
  const openMention = () => {
    const box = draftRef.current
    const caret = box?.selectionStart ?? draft.length
    setDraft(`${draft.slice(0, caret)}@${draft.slice(caret)}`)
    setMention({ query: '', index: 0 })
    window.setTimeout(() => {
      box?.focus()
      box?.setSelectionRange(caret + 1, caret + 1)
    }, 0)
  }

  const syncMention = (value: string, caret: number) => {
    const found = mentionAt(value, caret)
    setMention(found === null ? null : { query: found.query, index: 0 })
  }

  const insertMention = (number: string) => {
    const box = draftRef.current
    const caret = box?.selectionStart ?? draft.length
    const found = mentionAt(draft, caret)
    if (found === null) return
    setDraft(`${draft.slice(0, found.start)}@${number} ${draft.slice(caret)}`)
    setMention(null)
    const at = found.start + number.length + 2
    window.setTimeout(() => {
      box?.focus()
      box?.setSelectionRange(at, at)
    }, 0)
  }

  const send = async () => {
    const text = draft.trim()
    if (text === '' || sending) return
    const tokens = Array.from(new Set(Array.from(text.matchAll(/@(\d{1,3})/gu)).map(match => match[1] ?? '')))
    const picked = tokens
      .map(number => roster.find(entry => entry.number === number)?.member)
      .filter((entry): entry is Member => entry !== undefined)
    if (tokens.length > 0 && picked.length === 0) {
      setSendError(`没有找到成员 ${tokens.join('、')}`)
      return
    }
    // The mention is addressing, not content: the bubble already renders it.
    const content = text.replace(/^(\s*@\d{1,3}\s*)+/u, '').trim() || text
    setSending(true)
    setSendError('')
    try {
      const result = await api.sendConversation(content, picked.map(entry => entry.id))
      setDraft('')
      setMention(null)
      if (result.errors.length > 0) {
        setSendError(`${result.errors.map(entry => entry.member).join('、')} 发送失败：${result.errors[0]?.error ?? ''}`)
      }
      await load()
    } catch (cause) {
      setSendError(errorText(cause))
    } finally {
      setSending(false)
    }
  }

  /** Numbers mentioned in the draft, in the order they appear. */
  const mentioned = Array.from(new Set(Array.from(draft.matchAll(/@(\d{1,3})/gu)).map(match => match[1] ?? '')))
  const scopeText = mentioned.length === 0
    ? '发给全员'
    : `发给 ${mentioned.join('、')} 号`

  // Grow with the text, then scroll: the transcript keeps the room it needs.
  useEffect(() => {
    const box = draftRef.current
    if (box === null) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(168, box.scrollHeight)}px`
  }, [draft])

  return (
    <div className="dsh-pw-tabbody" style={chatColors}>
      <div className="chat-page" style={{ display: detail === null && member === null ? undefined : 'none' }}>
        <div className="chat-scroll" onClick={reloadOnClick}>
          {error !== '' ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
          {groups.length === 0 && !loading && error === '' ? <Empty description="还没有成员" /> : null}
          {groups.length > 0 ? (
            <div className="chat-stream">
              {messages.length === 0 ? <Empty description="还没有对话" /> : null}
              {messages.map(entry => (
                <ChatBubble key={entry.key} message={entry} onDetail={openDetail} onMember={setMemberIp} />
              ))}
              <div ref={messagesRef} />
            </div>
          ) : null}
        </div>
        <div className="chat-composer">
          {mention !== null && suggestions.length > 0 ? (
            <div className="chat-mention-menu" role="listbox" aria-label="选择成员">
              {suggestions.map((entry, index) => (
                <button
                  key={entry.member.id}
                  type="button"
                  role="option"
                  aria-selected={index === mention.index}
                  className={`chat-mention-item ${index === mention.index ? 'chat-mention-item-active' : ''}`}
                  // mousedown, not click: the textarea must not lose the caret.
                  onMouseDown={(event) => { event.preventDefault(); insertMention(entry.number) }}
                >
                  <span className="chat-avatar" style={{ background: chatAvatarColor(entry.number) }}>
                    {entry.number}
                  </span>
                  <span className="chat-mention-name">{entry.member.name}</span>
                  {entry.member.online ? null : (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>离线</Typography.Text>
                  )}
                </button>
              ))}
            </div>
          ) : null}
          <div className="chat-composer-box">
            <textarea
              ref={draftRef}
              className="chat-composer-input"
              value={draft}
              rows={1}
              placeholder="发消息给成员，@ 选择成员"
              onChange={(event) => {
                setDraft(event.target.value)
                syncMention(event.target.value, event.target.selectionStart ?? event.target.value.length)
              }}
              onClick={(event) => syncMention(draft, event.currentTarget.selectionStart ?? draft.length)}
              onKeyDown={(event) => {
                if (mention !== null && suggestions.length > 0) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const step = event.key === 'ArrowDown' ? 1 : suggestions.length - 1
                    setMention({ ...mention, index: (mention.index + step) % suggestions.length })
                    return
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault()
                    const entry = suggestions[mention.index]
                    if (entry !== undefined) insertMention(entry.number)
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setMention(null)
                    return
                  }
                }
                if (event.key === 'Enter' && event.shiftKey === false) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="chat-composer-bar">
              <div className="chat-composer-tools">
                <button
                  type="button"
                  className="chat-composer-add"
                  aria-label="选择成员"
                  title="选择成员"
                  onClick={openMention}
                >
                  @
                </button>
                <span className="chat-composer-scope">{scopeText}</span>
              </div>
              <Button
                className="chat-composer-send"
                type="primary"
                shape="circle"
                aria-label="发送"
                loading={sending}
                disabled={draft.trim() === ''}
                icon={sending ? undefined : <ArrowUpOutlined />}
                onClick={() => { void send() }}
              />
            </div>
          </div>
          {sendError === '' ? null : (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>{sendError}</Typography.Text>
          )}
        </div>
      </div>
      <div style={{ display: member === null ? 'none' : undefined }}>
        {member === null ? null : (
          <div className="chat-detail">
            <div className="chat-detail-bar">
              <Button type="text" icon={<ArrowLeftOutlined />} size="small" onClick={() => setMemberIp('')} aria-label="返回" />
            </div>
            <MemberStatus member={member} />
          </div>
        )}
      </div>
      <div style={{ display: detail === null ? 'none' : undefined }}>
        {detail === null ? null : (
          <div className="chat-detail">
            <div className="chat-detail-bar">
              <Button type="text" icon={<ArrowLeftOutlined />} size="small" onClick={closeDetail} aria-label="返回" />
            </div>
            <div className="chat-detail-text">{renderMarkdown(detail.text)}</div>
          </div>
        )}
      </div>
    </div>
  )
}

function Panel({ ctx }: { ctx: any }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [gateAvailable, setGateAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [startingHint, setStartingHint] = useState('')
  const [startupRetry, setStartupRetry] = useState(0)
  const [deployTarget, setDeployTarget] = useState<Member | null>(null)
  const [packages, setPackages] = useState<PackageInfo[]>([])
  const [packagesDir, setPackagesDir] = useState('')
  const [packagesLoading, setPackagesLoading] = useState(false)
  const [packagesError, setPackagesError] = useState('')
  const [selectedPackage, setSelectedPackage] = useState<string | undefined>(undefined)
  const [deployJobs, setDeployJobs] = useState<DeployJob[]>([])
  const [progressJob, setProgressJob] = useState<DeployJob | null>(null)
  const [progressLog, setProgressLog] = useState<string[]>([])
  const deployStatusRef = useRef<Record<string, string>>({})
  const [panelTab, setPanelTab] = useState<'members' | 'network' | 'conversations'>('members')
  const [networkRefresh, setNetworkRefresh] = useState(0)
  // Bumped by the toolbar buttons; the conversation tab reloads when it changes.
  const [conversationRefresh, setConversationRefresh] = useState(0)
  const [clearingConversations, setClearingConversations] = useState(false)

  const clearConversations = useCallback(async () => {
    setClearingConversations(true)
    try {
      const result = await api.clearConversations()
      if (result.errors.length > 0) {
        void message.warning(`清空完成，但有 ${String(result.errors.length)} 个成员失败`)
      } else {
        void message.success(result.removed > 0 ? `已清空 ${String(result.removed)} 条对话` : '没有可清空的对话')
      }
      setConversationRefresh(value => value + 1)
    } catch (failure) {
      void message.error(errorText(failure))
    } finally {
      setClearingConversations(false)
    }
  }, [])
  const [tags, setTags] = useState<Record<string, string>>({})
  const [tagTarget, setTagTarget] = useState<Member | null>(null)
  const [detailTarget, setDetailTarget] = useState<Member | null>(null)

  const [promoting, setPromoting] = useState('')
  const [tagText, setTagText] = useState('')
  const [tagSaving, setTagSaving] = useState(false)
  const [messageApi, contextHolder] = message.useMessage()
  const mode = useThemeMode(ctx)
  const screens = Grid.useBreakpoint()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const gate = await api.gateStatus()
      if (gate !== null) {
        setGateAvailable(true)
        setSnapshot(gate)
      } else {
        setGateAvailable(false)
        const members = await api.hostMembers()
        setSnapshot({ ...members, target: 'local' })
      }
      const memberTags = await api.memberTags()
      setTags(memberTags.tags)
      setError(null)
      setStartingHint('')
      setStartupRetry(0)
    } catch (failure) {
      setError(errorText(failure))
      if (isStartingError(failure)) {
        setStartingHint(failure instanceof ApiError && failure.kind === 'offline' ? OFFLINE_MESSAGE : STARTING_MESSAGE)
        setStartupRetry(count => count + 1)
      } else {
        setStartingHint('')
        setStartupRetry(0)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // A restart usually clears within a few seconds, so keep retrying on our own
  // instead of asking the user to refresh. Give up after roughly two minutes.
  useEffect(() => {
    if (startupRetry === 0 || startupRetry > 30) return
    const timer = window.setTimeout(() => { void load() }, 4000)
    return () => { window.clearTimeout(timer) }
  }, [startupRetry, load])

  const refreshDeployJobs = useCallback(async () => {
    try {
      const result = await api.deployJobs()
      setDeployJobs(result.jobs)
    } catch {
      // Keep the last snapshot when the host API is briefly busy.
    }
  }, [])

  useEffect(() => {
    void refreshDeployJobs()
    const timer = window.setInterval(() => { void refreshDeployJobs() }, 2000)
    return () => { window.clearInterval(timer) }
  }, [refreshDeployJobs])

  useEffect(() => {
    let finished = false
    for (const job of deployJobs) {
      const previous = deployStatusRef.current[job.id]
      deployStatusRef.current[job.id] = job.status
      if (previous === 'running' && job.status === 'succeeded') {
        messageApi.success(`部署完成：${job.release}`)
        finished = true
      }
      if (previous === 'running' && job.status === 'failed') {
        messageApi.error(`部署失败：${job.error ?? job.id}`)
        finished = true
      }
    }
    if (finished) void load()
  }, [deployJobs, load, messageApi])

  const openProgress = useCallback((job: DeployJob) => {
    setProgressLog([])
    setProgressJob(job)
  }, [])

  const latestJobOf = useCallback((member: Member): DeployJob | undefined => {
    return deployJobs.find(job => job.member === member.id || job.target?.host === member.ip)
  }, [deployJobs])

  const progressId = progressJob?.id ?? ''
  useEffect(() => {
    if (progressId === '') return
    let alive = true
    const tick = async () => {
      try {
        const result = await api.deployJob(progressId, 300)
        if (!alive) return
        setProgressJob(result.job)
        setProgressLog(result.lines)
      } catch {
        // Keep the last snapshot; the next tick retries.
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [progressId])

  const memberRows = useMemo(() => {
    if (snapshot === null) return []
    const local = snapshot.local
    const peers = snapshot.members.filter(member => member.id !== 'local')
    return local ? [local, ...peers] : peers
  }, [snapshot])

  const currentTarget = snapshot?.target ?? 'local'

  const openTag = useCallback((member: Member) => {
    setTagTarget(member)
    setTagText(tags[member.id] ?? '')
  }, [tags])

  const saveTag = useCallback(async () => {
    if (tagTarget === null) return
    setTagSaving(true)
    try {
      const result = await api.setMemberTag(tagTarget.id, tagText.trim())
      setTags(result.tags)
      setTagTarget(null)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setTagSaving(false)
    }
  }, [tagTarget, tagText])

  const switchMember = useCallback(async (member: Member) => {
    if (!gateAvailable) return
    setBusy(member.id)
    try {
      await api.gateSelect(member.id)
      window.location.reload()
    } catch (failure) {
      // The gate refuses an unusable member with a readable reason; the HTTP
      // status adds nothing for the operator.
      setError(failure instanceof ApiError ? failure.message : errorText(failure))
      setBusy('')
    }
  }, [gateAvailable])

  const loadPackages = useCallback(async (preferred?: 'linux' | 'windows', keepCurrent = false) => {
    setPackagesLoading(true)
    setPackagesError('')
    try {
      const result = await api.packages()
      setPackages(result.packages)
      setPackagesDir(result.dir)
      setSelectedPackage(current => {
        const keep = keepCurrent && current !== undefined
          ? result.packages.find(item => item.name === current)
          : undefined
        const match = preferred !== undefined ? result.packages.find(item => item.target === preferred) : undefined
        return (keep ?? match)?.name
      })
    } catch (failure) {
      setPackagesError(errorText(failure))
      setPackages([])
      setSelectedPackage(undefined)
    } finally {
      setPackagesLoading(false)
    }
  }, [])

  const openDeploy = useCallback((member: Member) => {
    setDeployTarget(member)
    setPackages([])
    setPackagesDir('')
    setPackagesError('')
    setSelectedPackage(undefined)
    void loadPackages(preferredTarget(member))
  }, [loadPackages])

  const deploy = useCallback(async () => {
    if (deployTarget === null || selectedPackage === undefined) return
    setBusy(deployTarget.id)
    try {
      const result = await api.deploy(deployTarget.id, selectedPackage)
      setDeployTarget(null)
      setError(null)
      setDeployJobs(current => [result.job, ...current.filter(job => job.id !== result.job.id)])
      openProgress(result.job)
      messageApi.info(`部署已开始：${result.job.id}`)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy('')
    }
  }, [deployTarget, selectedPackage, messageApi, openProgress])

  const columns: ColumnsType<Member> = useMemo(() => {
    const actionColumn: ColumnsType<Member>[number] = {
      title: '操作',
      key: 'action',
      // Wide enough for the running-deploy pill (spinner + "正在部署 62%");
      // a percentage forces the label onto a second line otherwise.
      width: screens.lg === true ? 160 : 140,
      align: 'right',
      render: (_value, member) => {
        const runningJob = deployJobs.find(job => job.status === 'running'
          && (job.member === member.id || job.target?.host === member.ip))
        if (runningJob !== undefined) {
          return (
            <Button
              size="small"
              icon={<LoadingOutlined />}
              onClick={() => openProgress(runningJob)}
            >
              正在部署 {deployPercent(runningJob)}%
            </Button>
          )
        }
        if (member.id === currentTarget) return <Tag color="blue">当前</Tag>
        if (member.dsh && gateAvailable && member.port !== null) {
          return (
            <Button
              size="small"
              icon={<SwapOutlined />}
              loading={busy === member.id}
              onClick={() => { void switchMember(member) }}
            >
              切换
            </Button>
          )
        }
        if (!member.dsh) {
          return (
            <Button
              size="small"
              icon={<CloudDownloadOutlined />}
              onClick={() => openDeploy(member)}
            >
              部署
            </Button>
          )
        }
        return <Typography.Text type="secondary">—</Typography.Text>
      },
    }
    const base: ColumnsType<Member> = [
      {
        title: '成员',
        key: 'member',
        width: screens.lg === true ? '15%' : 200,
        render: (_value, member) => (
          <span className="dsh-pw-member">
            <Tooltip title={member.name}>
              <Typography.Text strong className="dsh-pw-member-name">
                {shortMemberName(member.name)}
              </Typography.Text>
            </Tooltip>
            <Button
              type="text"
              size="small"
              className="dsh-pw-member-detail"
              icon={<InfoCircleOutlined />}
              title="成员详情"
              aria-label={`查看 ${member.name} 的详情`}
              onClick={() => setDetailTarget(member)}
            />
          </span>
        ),
      },
      {
        title: '地址',
        key: 'address',
        width: screens.lg === true ? '10%' : 110,
        responsive: ['lg'],
        render: (_value, member) => (
          <Typography.Text className="dsh-pw-mono" style={{ fontSize: 12 }}>
            {member.ip || member.id}
          </Typography.Text>
        ),
      },
      {
        title: '标签',
        key: 'tag',
        width: screens.lg === true ? '9%' : 120,
        responsive: ['md'],
        render: (_value, member) => (
          <Space size={4} wrap>
            {tags[member.id] !== undefined ? <Tag color="blue">{tags[member.id]}</Tag> : null}
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              title="设置标签"
              onClick={() => openTag(member)}
            />
          </Space>
        ),
      },
      {
        title: '状态',
        key: 'status',
        width: screens.lg === true ? '16%' : 190,
        responsive: ['sm'],
        render: (_value, member) => (
          <Space size={6} wrap>
            <Tag color={member.online ? 'green' : 'default'}>{member.online ? '在线' : '离线'}</Tag>
            {member.kind === 'self'
              ? <Tag color="blue">本机</Tag>
              : member.dsh
                ? <Tag color="cyan">DSH :{String(member.port ?? '?')}</Tag>
                : <Tag>未部署</Tag>}
            {member.latencyMs > 0 ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>{String(member.latencyMs)} ms</Typography.Text> : null}
          </Space>
        ),
      },
      {
        title: '系统',
        key: 'system',
        width: screens.lg === true ? '39%' : 260,
        responsive: ['lg'],
        render: (_value, member) => (
          <Tooltip title={<pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>{systemDetails(member)}</pre>}>
            <Typography.Text style={{ fontSize: 12 }}>{systemText(member)}</Typography.Text>
          </Tooltip>
        ),
      },
    ]
    return [...base, actionColumn]
  }, [busy, currentTarget, deployJobs, gateAvailable, openDeploy, openProgress, openTag, screens, switchMember, tags])

  if (loading && snapshot === null) {
    return (
      <ConfigProvider
        locale={ctx.locale.getSnapshot().active?.startsWith('zh') === false ? enUS : zhCN}
        theme={{ algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}
      >
        <style>{styles}</style>
        <div className="dsh-pw-boot">
          <Typography.Title level={3} style={{ margin: 0 }}>Mesh</Typography.Title>
          <Spin size="large" />
        </div>
      </ConfigProvider>
    )
  }

  return (
    <ConfigProvider
      locale={ctx.locale.getSnapshot().active?.startsWith('zh') === false ? enUS : zhCN}
      theme={{ algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}
    >
      <style>{styles}</style>
      <div className="dsh-pw-page">
        <div className="dsh-pw-header">
          <div>
            <h1 className="dsh-pw-title">Mesh</h1>
          </div>
          <div className="dsh-pw-toolbar">
            <Tag icon={gateAvailable ? <ApartmentOutlined /> : <WarningOutlined />} color={gateAvailable ? 'green' : 'default'}>
              {gateAvailable ? '网关已连接' : '本机直连'}
            </Tag>
          </div>
        </div>

        {error !== null ? (
          <div className="dsh-pw-error">
          {startingHint !== '' ? (
            <Alert
              type="warning"
              showIcon
              message={startingHint === OFFLINE_MESSAGE ? '连接中断' : '服务正在启动'}
              description={startupRetry > 30
                ? '自动重试已停止，请稍后手动刷新。'
                : `${startingHint === OFFLINE_MESSAGE ? '无法连接到本机服务，可能正在重启。' : 'DeepSeek Harness 正在启动或重启，通常需要十几秒。'}页面会自动重试。`}
              action={(
                <Space size={6}>
                  <Button size="small" loading={loading} onClick={() => { void load() }}>重试</Button>
                  <Button size="small" type="text" onClick={() => { setError(null); setStartingHint(''); setStartupRetry(0) }}>关闭</Button>
                </Space>
              )}
              style={{ marginBottom: 14 }}
            />
          ) : (
            <Alert
              type="error"
              showIcon
              closable
              message="操作失败"
              description={error}
              onClose={() => setError(null)}
              style={{ marginBottom: 14 }}
            />
          )}
          </div>
        ) : null}

        <Tabs
          className="dsh-pw-tabs"
          activeKey={panelTab}
          onChange={key => setPanelTab(key as 'members' | 'network' | 'conversations')}
          tabBarExtraContent={panelTab === 'conversations' ? (
            <Space size={4}>
              <Tooltip title="清空已完成对话">
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  disabled={clearingConversations}
                  onClick={() => { void clearConversations() }}
                />
              </Tooltip>
              <Tooltip title="刷新">
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => setConversationRefresh(value => value + 1)}
                />
              </Tooltip>
            </Space>
          ) : panelTab === 'members' ? (
            <Tooltip title="刷新成员">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => { void load() }}
              />
            </Tooltip>
          ) : panelTab === 'network' ? (
            <Tooltip title="刷新已加入设备">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => setNetworkRefresh(value => value + 1)}
              />
            </Tooltip>
          ) : undefined}
          items={[
            {
              key: 'members',
              label: '成员',
              children: (
        <div className="dsh-pw-tabbody">
        <Card size="small">
              <Table<Member>
                rowKey="id"
                size="middle"
                dataSource={memberRows}
                columns={columns}
                scroll={{
                  // 820 keeps the last column inside the card at lg; a larger
                  // minimum made the table wider than its container and clipped
                  // the running-deploy pill.
                  x: screens.lg === true ? 820 : undefined,
                  ...(memberRows.length > 8 ? { y: 'max(240px, calc(100vh - 320px))' } : {}),
                }}
                pagination={{
                  pageSize: 10,
                  showSizeChanger: true,
                  pageSizeOptions: ['10', '20', '50', '100'],
                  showTotal: total => `共 ${String(total)} 个成员`,
                  hideOnSinglePage: true,
                }}
                locale={{ emptyText: <Empty description="还没有发现成员" /> }}
              />
            </Card>
        </div>
              ),
            },
            {
              key: 'conversations',
              label: '对话',
              children: (
                <MemberConversations
                  active={panelTab === 'conversations'}
                  members={memberRows}
                  refreshToken={conversationRefresh}
                />
              ),
            },
            {
              key: 'network',
              label: '组网',
              children: (
                <div className="dsh-pw-tabbody">
                  <WireGuardPanel
                    ctx={ctx}
                    embedded
                    members={memberRows}
                    gateAvailable={gateAvailable}
                    refreshToken={networkRefresh}
                  />
                </div>
              ),
            },
          ]}
        />
        {contextHolder}
      </div>

      <Modal
        open={tagTarget !== null}
        title={`设置标签 · ${tagTarget?.name ?? ''}`}
        okText="保存"
        cancelText="取消"
        confirmLoading={tagSaving}
        onCancel={() => setTagTarget(null)}
        onOk={() => { void saveTag() }}
        destroyOnHidden
      >
        <Input
          maxLength={32}
          showCount
          value={tagText}
          placeholder="例如 生产 / 测试 / 客户 A"
          onChange={event => setTagText(event.target.value)}
          onPressEnter={() => { void saveTag() }}
        />
      </Modal>

      <Modal
        open={detailTarget !== null}
        title={detailTarget !== null ? `${detailTarget.name} · 详情` : '成员详情'}
        width={560}
        footer={(
          <Space>
            {detailTarget !== null && String(detailTarget.system?.platform ?? '').toLowerCase().startsWith('win') ? (
              <Tooltip title="让这台 Windows 成员的 DSH 在交互会话里运行（沙箱、截屏、扫码都依赖它）。没有交互管理员时会保持原样。">
                <Button
                  loading={promoting !== ''}
                  onClick={() => {
                    const target = detailTarget
                    if (target === null) return
                    setPromoting(target.id)
                    api.promoteSession(target.id)
                      .then(result => {
                        const mode = typeof result.status?.mode === 'string' ? result.status.mode : 'unknown'
                        const detail = typeof result.status?.detail === 'string' ? result.status.detail : ''
                        void messageApi.success(`已请求提升：${mode}${detail !== '' ? `（${detail}）` : ''}`)
                      })
                      .catch((cause: unknown) => { void messageApi.error(errorText(cause)) })
                      .finally(() => setPromoting(''))
                  }}
                >
                  提升到交互会话
                </Button>
              </Tooltip>
            ) : null}
            <Button onClick={() => setDetailTarget(null)}>关闭</Button>
          </Space>
        )}
        onCancel={() => setDetailTarget(null)}
        destroyOnHidden
      >
        {detailTarget !== null ? (
          <Descriptions
            size="small"
            bordered
            column={1}
            styles={{
              label: { width: 80, whiteSpace: 'nowrap' },
              content: { minWidth: 0 },
            }}
            items={[
              { key: 'name', label: '名称', children: detailTarget.name },
              { key: 'id', label: 'ID', children: <span className="dsh-pw-mono">{detailTarget.id}</span> },
              { key: 'address', label: '地址', children: <span className="dsh-pw-mono">{detailTarget.ip || '—'}</span> },
              {
                key: 'tag',
                label: '标签',
                children: tags[detailTarget.id] !== undefined ? <Tag color="blue">{tags[detailTarget.id]}</Tag> : '—',
              },
              {
                key: 'status',
                label: '状态',
                children: (
                  <Space size={6} wrap>
                    <Tag color={detailTarget.online ? 'green' : 'default'}>{detailTarget.online ? '在线' : '离线'}</Tag>
                    <Typography.Text type="secondary">
                      {detailTarget.kind === 'self' ? '本机' : '成员'}
                    </Typography.Text>
                  </Space>
                ),
              },
              {
                key: 'dsh',
                label: 'DSH',
                children: detailTarget.kind === 'self'
                  ? '本机'
                  : detailTarget.dsh ? `:${String(detailTarget.port ?? '?')}` : '未部署',
              },
              {
                key: 'latency',
                label: '延迟',
                children: detailTarget.latencyMs > 0 ? `${String(detailTarget.latencyMs)} ms` : '—',
              },
              {
                key: 'host',
                label: '主机',
                children: detailTarget.gate?.hostname !== undefined ? String(detailTarget.gate.hostname) : '—',
              },
              {
                key: 'system',
                label: '系统',
                children: <pre className="dsh-pw-detail-pre">{systemDetails(detailTarget)}</pre>,
              },
              ...(detailTarget.error !== null && detailTarget.error !== undefined
                ? [{ key: 'error', label: '错误', children: <Typography.Text type="danger">{detailTarget.error}</Typography.Text> }]
                : []),
            ]}
          />
        ) : null}
      </Modal>

      <Modal
        open={deployTarget !== null}
        title={`部署到 ${deployTarget?.name ?? ''}`}
        okText="开始部署"
        cancelText="取消"
        confirmLoading={busy !== ''}
        okButtonProps={{ disabled: selectedPackage === undefined }}
        onCancel={() => setDeployTarget(null)}
        onOk={() => { void deploy() }}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            部署包来自本机：<span className="dsh-pw-mono">{packagesDir || '~/.dsh/packages'}</span>
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            部署到成员目录：<span className="dsh-pw-mono">{memberAppRoot(deployTarget) || '沿用成员现有安装目录（部署时自动探测）'}</span>
            {deployTarget?.system?.home !== undefined && deployTarget.system.home !== ''
              ? `（~：${deployTarget.system.home}）`
              : ''}
          </Typography.Text>
          {deployTarget !== null ? (() => {
            const job = latestJobOf(deployTarget)
            if (job === undefined) return null
            return (
              <Space size={8} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近一次部署：</Typography.Text>
                <Tag color={job.status === 'succeeded' ? 'success' : job.status === 'failed' ? 'error' : 'processing'}>
                  {job.status === 'succeeded' ? '成功' : job.status === 'failed' ? '失败' : '进行中'}
                </Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(job.createdAt).toLocaleString()}
                </Typography.Text>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    setDeployTarget(null)
                    openProgress(job)
                  }}
                >
                  查看详情
                </Button>
              </Space>
            )
          })() : null}
          <Space.Compact style={{ width: '100%' }}>
            <Select
              style={{ width: '100%' }}
              loading={packagesLoading}
              value={selectedPackage}
              placeholder={packages.length === 0 ? '目录里没有部署包' : '选择部署包'}
              onChange={value => setSelectedPackage(value)}
              options={packages.map(item => ({
                value: item.name,
                label: `${item.name}  ·  ${item.target === 'windows' ? 'Windows' : 'Linux'}  ·  ${formatBytes(item.bytes)}`,
              }))}
            />
            <Button icon={<ReloadOutlined />} loading={packagesLoading} onClick={() => { void loadPackages(undefined, true) }}>
              刷新
            </Button>
          </Space.Compact>
          {packagesError !== '' ? <Alert type="error" showIcon message={packagesError} /> : null}
          {!packagesLoading && packages.length === 0 && packagesError === '' ? (
            <Alert
              type="info"
              showIcon
              message="没有可用的部署包"
              description="把 .tar.gz / .zip 部署包放进本机 ~/.dsh/packages/，再点刷新。"
            />
          ) : null}
        </Space>
      </Modal>

      <Modal
        open={progressJob !== null}
        title={`部署进度 · ${
          progressJob === null
            ? ''
            : memberRows.find(row => row.id === progressJob.member || row.ip === progressJob.target.host)?.name
              ?? progressJob.target.host
        }`}
        onCancel={() => setProgressJob(null)}
        footer={<Button onClick={() => setProgressJob(null)}>关闭</Button>}
        width={760}
        destroyOnHidden
      >
        {progressJob !== null ? <DeployProgressView job={progressJob} lines={progressLog} /> : null}
      </Modal>
    </ConfigProvider>
  )
}

function SidebarIcon({ size = 20 }: { size?: number }) {
  return <ApartmentOutlined style={{ fontSize: size }} />
}

export const inject = ['slots', 'locale', 'theme']

export function apply(ctx: any) {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.setAttribute('data-dsh-mesh', 'hide-preview-badge')
    tag.textContent = '[class*="previewBadge"]{display:none!important}'
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'mesh: hide preview badge')
  ctx.effect(() => ctx.locale.register(NS, {
    en: { 'panel.label': 'Mesh' },
    zh: { 'panel.label': 'Mesh' },
  }), 'mesh dictionaries')
  ctx.effect(() => ctx.locale.register('dsh-wireguard', {
    en: WIREGUARD_EN,
    zh: wireguardDictionary('zh'),
  }), 'wireguard dictionaries')
  const t = ctx.locale.bind(NS)
  const page = (props: any) => <Panel {...props} ctx={ctx} />
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, page))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 21,
    label: () => t('panel.label'),
  }, SidebarIcon))
}
