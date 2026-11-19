import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Descriptions,
  Dropdown,
  Empty,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Segmented,
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
  CloudDownloadOutlined,
  CloudUploadOutlined,
  ClockCircleOutlined,
  ExperimentOutlined,
  EditOutlined,
  EllipsisOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  StopOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import styles from './styles.css'
import { useEventStream } from './events'
import {
  api,
  ApiError,
  isStartingError,
  STARTING_MESSAGE,
  OFFLINE_MESSAGE,
  type DeployJob,
  type DeploymentInfo,
  type LatestRelease,
  type Member,
  type PackageInfo,
  type Snapshot,
  type SystemInfo,
  type TargetPackageInfo,
} from './api'
import { WireGuardPanel } from './wireguard'
import { PackagesPanel } from './packages'
import { AutoUpgradeModal } from './schedule'
import { EN as WIREGUARD_EN, dictionary as wireguardDictionary } from './wireguard/i18n'

const NS = 'dsh-mesh'
const PANEL_ID = 'mesh'
const MEMBER_NAME_LIMIT = 12

/** Members show a short label in the table; the full name lives in the detail modal. */
function shortMemberName(name: string): string {
  const chars = Array.from(name)
  return chars.length > MEMBER_NAME_LIMIT ? `${chars.slice(0, MEMBER_NAME_LIMIT).join('')}…` : name
}

/**
 * Minimum member-table width per breakpoint: the summed widths of the columns
 * that breakpoint still shows (the action column is 170 everywhere). Once the
 * container is narrower than this, the table scrolls sideways instead of
 * squeezing the cells into a ball on a phone.
 *
 * An unmeasured viewport (`screens` empty on first render) falls through to the
 * desktop width so a desktop never flashes a narrow table.
 */
function memberTableMinWidth(screens: Partial<Record<'sm' | 'md' | 'lg', boolean>>): number {
  if (screens.lg !== false) return 820
  if (screens.md !== false) return 770
  if (screens.sm !== false) return 650
  return 460
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

/**
 * The release asset key for a member (`linux-x64`, `win-x64`).
 *
 * The probe reports `x64`/`arm64`; an older member may not report the arch, in
 * which case x64 is the only artifact a normal build produces.
 * @param {Member | null} member member row.
 * @returns {string | undefined} target key.
 */
function memberTargetKey(member: Member | null): string | undefined {
  if (member === null) return undefined
  const os = preferredTarget(member)
  const arch = String(member.system?.arch ?? '').toLowerCase() === 'arm64' ? 'arm64' : 'x64'
  if (os === 'windows') return `win-${arch}`
  if (os === 'linux') return `linux-${arch}`
  return undefined
}

/** The member's install root, straight from its system info when it is up. */
function memberAppRoot(member: Member | null): string {
  if (member === null) return ''
  const system = memberSystem(member)
  const root = system?.appRoot?.trim() ?? ''
  // A blue-green member reports the release it runs from (`<root>/current`,
  // a symlink); the operator thinks in terms of the install root, and that is
  // the directory an upgrade replaces.
  if (root !== '') return root.replace(/[\\/]current$/u, '')
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

/** The release a member reports: its own row when local, else its gate's answer. */
function memberDeployment(member: Member): DeploymentInfo | null {
  const direct = member.deployment
  if (direct !== null && direct !== undefined && typeof direct === 'object') return direct
  const nested = (member.gate as { deployment?: DeploymentInfo } | null)?.deployment
  return nested !== null && nested !== undefined && typeof nested === 'object' ? nested : null
}

/**
 * Version and build stamp encoded in a deployment package filename.
 *
 * Older members do not report their release yet, so the newest successful
 * deploy/upgrade job is the best available answer until they do.
 */
function packageDeployment(job: DeployJob | undefined): { version: string; buildStamp: string | null } | null {
  const name = (job?.package ?? '').split(/[\\/]/u).pop() ?? ''
  const match = /^dsh-mesh-(.+?)(?:-(\d{8}[A-Z]))?-(?:linux|win(?:dows)?)-/u.exec(name)
  if (match === null || match[1] === undefined) return null
  return { version: match[1], buildStamp: match[2] ?? null }
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
  upload: [0, 55],
  // 测试升级在 prepare 之前多一段演练（解压 + 两次 300 MB 拷贝），把它算进来，
  // 否则进度条会在演练的几分钟里一直停在 0%。
  rehearse: [55, 80],
  prepare: [80, 92],
  activate: [92, 100],
}

/** The operator-facing name of a deploy job: 升级 / 测试升级 / 部署. */
function deployAction(job: DeployJob): string {
  return job.mode === 'upgrade' ? '升级' : job.mode === 'test' ? '测试升级' : '部署'
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

/**
 * Merge pushed deploy snapshots into the table.
 *
 * A reconnect can replay an older frame; `updatedAt` makes the newer one win so
 * the progress column never moves backwards.
 * @param previous current rows.
 * @param incoming pushed rows.
 * @returns rows newest first.
 */
function mergeDeployJobs(previous: DeployJob[], incoming: DeployJob[]): DeployJob[] {
  const byId = new Map(previous.map(job => [job.id, job] as const))
  for (const job of incoming) {
    const existing = byId.get(job.id)
    if (existing === undefined || String(job.updatedAt ?? job.createdAt) >= String(existing.updatedAt ?? existing.createdAt)) byId.set(job.id, job)
  }
  return [...byId.values()].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
}

function DeployProgressView({ job, lines }: { job: DeployJob; lines: string[] }) {
  // Older hosts returned the log as one string; never assume the array shape.
  const logLines = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/u)
  // An upgrade and a first install run the same phases; only the wording
  // differs, and the operator needs to know which one is happening.
  const action = job.mode === 'upgrade' ? '升级' : job.mode === 'test' ? '测试升级' : '部署'
  const progress = job.progress
  const total = progress?.totalBytes ?? 0
  const bytes = progress?.bytes ?? 0
  const speed = progress?.speed ?? 0
  const indeterminate = progress?.indeterminate === true
  const percent = indeterminate ? 100 : Math.max(0, Math.min(100, progress?.percent ?? 0))
  const active = job.status === 'running' || job.status === 'queued'
  const cancelled = job.status === 'cancelled'
  // The meter is shared by the upload and the extraction: same bar, different
  // unit. `label` comes from the deploy engine, which is the only place that
  // knows which phase is running.
  const meters = progress?.total ?? 0
  const meterLabel = progress?.label ?? '获取安装包'
  const meterText = total > 0
    ? (indeterminate
      ? `已上传 ${formatBytes(bytes)} / ${formatBytes(total)}（服务器不支持流式上传，无法显示百分比）`
      : `${formatBytes(bytes)} / ${formatBytes(total)}${speed > 0 ? ` · ${formatBytes(speed)}/s` : ''}${etaText(speed, total - bytes)}`)
    : meters > 0 ? `已解压 ${progress?.done ?? 0} / ${meters} 项` : ''
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space size={8} wrap>
        {active
          ? <Tag color="processing">{action}中 {deployPercent(job)}%</Tag>
          : job.status === 'succeeded'
            ? <Tag color="success">{action}成功</Tag>
            : cancelled
              ? <Tag>{action}已取消</Tag>
              : <Tag color="error">{action}失败</Tag>}
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
          status={cancelled ? 'normal' : job.status === 'failed' ? 'exception' : percent >= 100 ? 'success' : 'active'}
          showInfo={!indeterminate}
        />
        {meterText === '' ? null : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{meterText}</Typography.Text>
        )}
      </div>
      <Steps
        direction="vertical"
        size="small"
        status={cancelled ? 'wait' : job.status === 'failed' ? 'error' : job.status === 'succeeded' ? 'finish' : 'process'}
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
      {job.status === 'failed' ? <Alert type="error" showIcon message={`${action}失败`} description={job.error ?? '未知错误'} /> : null}
      {cancelled ? <Alert type="warning" showIcon message={`${action}已取消`} description={job.error ?? '升级进程已停止，临时文件已清理'} /> : null}
      {job.status === 'succeeded' ? <Alert type="success" showIcon message={`${action}完成`} description={`健康检查通过，发布 ${job.release}`} /> : null}
      <div>
        <Typography.Text strong>日志</Typography.Text>
        <pre className="dsh-pw-deploy-log">{logLines.length > 0 ? logLines.slice(-200).join('\n') : '等待日志…'}</pre>
      </div>
    </Space>
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
  // The same dialog installs a fresh member and upgrades an existing one; the
  // intent only decides the wording and which API is called.
  const [deployIntent, setDeployIntent] = useState<'install' | 'upgrade' | 'test'>('install')
  // Three package sources: the gateway cache, the public latest tag, and an
  // archive that is already on the target member.
  const [packageSource, setPackageSource] = useState<'local' | 'latest' | 'target'>('local')
  const [packages, setPackages] = useState<PackageInfo[]>([])
  const [packagesDir, setPackagesDir] = useState('')
  const [packagesLoading, setPackagesLoading] = useState(false)
  const [packagesError, setPackagesError] = useState('')
  const [selectedPackage, setSelectedPackage] = useState<string | undefined>(undefined)
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null)
  const [latestLoading, setLatestLoading] = useState(false)
  const [latestError, setLatestError] = useState('')
  const [selectedAsset, setSelectedAsset] = useState<string | undefined>(undefined)
  const [targetPackages, setTargetPackages] = useState<TargetPackageInfo[]>([])
  const [targetPackagesLoading, setTargetPackagesLoading] = useState(false)
  const [targetPackagesError, setTargetPackagesError] = useState('')
  const [selectedTargetPackage, setSelectedTargetPackage] = useState<string | undefined>(undefined)
  // Upgrade downloads prefer the release; `auto` lets the server pick the
  // external-network member, `none` uses the target's own network.
  const [downloadProxy, setDownloadProxy] = useState<string>('auto')
  const [deployJobs, setDeployJobs] = useState<DeployJob[]>([])
  const [progressJob, setProgressJob] = useState<DeployJob | null>(null)
  const [progressLog, setProgressLog] = useState<string[]>([])
  // One cancel request at a time; the id keeps the button's spinner on its job.
  const [cancelling, setCancelling] = useState('')
  const deployStatusRef = useRef<Record<string, string>>({})
  const [panelTab, setPanelTab] = useState<'members' | 'network' | 'packages'>('members')
  const [networkRefresh, setNetworkRefresh] = useState(0)
  const [tags, setTags] = useState<Record<string, string>>({})
  const [tagTarget, setTagTarget] = useState<Member | null>(null)
  const [detailTarget, setDetailTarget] = useState<Member | null>(null)
  const [autoUpgradeTarget, setAutoUpgradeTarget] = useState<Member | null>(null)

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

  /**
   * Put a member back on the release it ran before the failed upgrade.
   *
   * A broken member often keeps its gateway down, so the panel that started the
   * upgrade is the only place left that can fix it without a shell.
   */
  const rollbackDeployJob = useCallback(async (job: DeployJob) => {
    if (job.member === null || job.member === undefined || job.member === 'local') return
    try {
      const result = await api.rollback(job.member)
      messageApi.info(`回滚已开始：${result.job.id}`)
      setProgressJob(result.job)
      await refreshDeployJobs()
    } catch (failure) {
      messageApi.error(errorText(failure))
    }
  }, [messageApi])

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
  }, [refreshDeployJobs])

  // Deploy changes arrive on the same push stream as builds; the only fetch is
  // the resync after a (re)connect.
  useEventStream('/api/dsh-mesh/events', event => {
    const type = event.type ?? ''
    if (type === 'ready') {
      // Connect/reconnect: resync the table and the open dialog once.
      void refreshDeployJobs()
      if (progressJob !== null) {
        void api.deployJob(progressJob.id, 300).then(result => {
          setProgressJob(result.job)
          setProgressLog(result.lines)
        }).catch(() => {})
      }
      return
    }
    if (type === 'deploy' && event.job !== undefined) {
      const job = event.job as unknown as DeployJob
      setDeployJobs(previous => mergeDeployJobs(previous, [job]))
      setProgressJob(current => (current !== null && current.id === job.id ? job : current))
      return
    }
    if (type === 'deploy-log' && event.id !== undefined && event.id === progressJob?.id) {
      setProgressLog(Array.isArray(event.lines) ? event.lines : [])
    }
  })

  useEffect(() => {
    let finished = false
    for (const job of deployJobs) {
      const previous = deployStatusRef.current[job.id]
      deployStatusRef.current[job.id] = job.status
      if (previous === 'running' && job.status === 'succeeded') {
        messageApi.success(`${job.mode === 'upgrade' ? '升级' : job.mode === 'test' ? '测试升级' : '部署'}完成：${job.release}`)
        finished = true
      }
      if (previous === 'running' && job.status === 'failed') {
        messageApi.error(`${job.mode === 'upgrade' ? '升级' : job.mode === 'test' ? '测试升级' : '部署'}失败：${job.error ?? job.id}`)
        finished = true
      }
      if ((previous === 'running' || previous === 'queued') && job.status === 'cancelled') {
        messageApi.info(`${job.mode === 'upgrade' ? '升级' : job.mode === 'test' ? '测试升级' : '部署'}已取消`)
        finished = true
      }
    }
    if (finished) void load()
  }, [deployJobs, load, messageApi])

  const openProgress = useCallback((job: DeployJob) => {
    setProgressLog([])
    setProgressJob(job)
  }, [])

  /**
   * Stop a queued/running upgrade and let the server clean up.
   *
   * The button is only offered while the job is queued or running; the server
   * refuses once the activate step starts switching the member's services.
   */
  const cancelDeployJob = useCallback(async (job: DeployJob) => {
    setCancelling(job.id)
    try {
      const result = await api.cancelDeploy(job.id)
      setProgressJob(current => (current !== null && current.id === job.id ? result.job : current))
      setDeployJobs(current => [result.job, ...current.filter(item => item.id !== job.id)])
      if (result.job.status === 'cancelled') {
        messageApi.success('已取消：升级进程已停止，临时文件已清理')
      } else {
        messageApi.info(`任务已经结束（${result.job.status}），无需取消`)
      }
    } catch (failure) {
      messageApi.error(errorText(failure))
    } finally {
      setCancelling('')
    }
  }, [messageApi])

  const latestJobOf = useCallback((member: Member): DeployJob | undefined => {
    return deployJobs.find(job => job.member === member.id || job.target?.host === member.ip)
  }, [deployJobs])

  /** Newest successful deploy/upgrade of a member; the version fallback for old gates. */
  const latestSucceededJobOf = useCallback((member: Member): DeployJob | undefined => {
    return deployJobs.find(job => job.status === 'succeeded' && job.package !== undefined
      && (job.member === member.id || job.target?.host === member.ip))
  }, [deployJobs])

  const progressId = progressJob?.id ?? ''
  // One read when the dialog opens; every later change is pushed.
  useEffect(() => {
    if (progressId === '') return
    let alive = true
    void api.deployJob(progressId, 300).then(result => {
      if (!alive) return
      setProgressJob(result.job)
      setProgressLog(result.lines)
    }).catch(() => {
      // The job may have been pruned; the pushed events still cover a live one.
    })
    return () => { alive = false }
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

  /** Read the public latest tag and preselect the asset for this member. */
  const loadLatest = useCallback(async (member: Member, refresh = false) => {
    setLatestLoading(true)
    setLatestError('')
    try {
      const result = await api.latestRelease(refresh)
      setLatestRelease(result)
      // With no release configured there is nothing to pick here; show the
      // local package list instead of an empty source the operator must guess
      // their way out of.
      if (result.configured === false) setPackageSource('local')
      const wanted = memberTargetKey(member)
      const os = preferredTarget(member)
      const match = result.assets.find(asset => asset.target === wanted)
        ?? result.assets.find(asset => asset.os === os)
        ?? (os === undefined ? result.assets[0] : undefined)
      setSelectedAsset(match?.target)
      if (result.ok !== true && result.configured !== false) setLatestError(result.error ?? '发布清单里没有可用的包')
    } catch (failure) {
      setLatestRelease(null)
      setSelectedAsset(undefined)
      setLatestError(errorText(failure))
    } finally {
      setLatestLoading(false)
    }
  }, [])

  /** Read archives that already exist on the target member. */
  const loadTargetPackages = useCallback(async (member: Member, keepCurrent = false) => {
    setTargetPackagesLoading(true)
    setTargetPackagesError('')
    try {
      const result = await api.targetPackages(member.id)
      const wanted = preferredTarget(member)
      const packages = wanted === undefined
        ? result.packages
        : result.packages.filter(item => item.os === wanted)
      setTargetPackages(packages)
      setSelectedTargetPackage(current => {
        const keep = keepCurrent && current !== undefined
          ? packages.find(item => item.path === current)
          : undefined
        return (keep ?? packages[0])?.path
      })
      if (result.ok !== true) setTargetPackagesError(result.error ?? '读取目标成员的包失败')
    } catch (failure) {
      setTargetPackages([])
      setSelectedTargetPackage(undefined)
      setTargetPackagesError(errorText(failure))
    } finally {
      setTargetPackagesLoading(false)
    }
  }, [])

  const openDeploy = useCallback((member: Member, intent: 'install' | 'upgrade' | 'test') => {
    const remote = member.kind !== 'self' && member.id !== 'local'
    // latest tag is an upgrade source for both the current gateway (the
    // detached runner downloads into the local cache) and remote members.
    const canLatest = intent === 'upgrade'
    const canTarget = remote && intent !== 'test'
    setDeployTarget(member)
    setDeployIntent(intent)
    setPackageSource(canLatest ? 'latest' : 'local')
    setPackages([])
    setPackagesDir('')
    setPackagesError('')
    setSelectedPackage(undefined)
    setLatestRelease(null)
    setLatestError('')
    setSelectedAsset(undefined)
    setTargetPackages([])
    setTargetPackagesError('')
    setSelectedTargetPackage(undefined)
    setDownloadProxy('auto')
    void loadPackages(preferredTarget(member))
    if (canLatest) void loadLatest(member)
    if (canTarget) void loadTargetPackages(member)
  }, [loadLatest, loadPackages, loadTargetPackages])

  const deploy = useCallback(async () => {
    if (deployTarget === null) return
    const asset = latestRelease?.assets.find(item => item.target === selectedAsset)
    const targetPackage = targetPackages.find(item => item.path === selectedTargetPackage)
    const ready = packageSource === 'latest'
      ? asset !== undefined
      : packageSource === 'target'
        ? targetPackage !== undefined
        : selectedPackage !== undefined
    if (!ready) return
    setBusy(deployTarget.id)
    try {
      const downloadOptions = downloadProxy === 'none'
        ? { direct: true }
        : downloadProxy === 'auto'
          ? {}
          : { proxyMember: downloadProxy }
      const result = packageSource === 'latest' && asset !== undefined
        ? await api.upgradeLatest(deployTarget.id, asset.target, downloadOptions)
        : packageSource === 'target' && targetPackage !== undefined
          ? deployIntent === 'install'
            ? await api.deployTargetPackage(deployTarget.id, targetPackage.path)
            : await api.upgradeTargetPackage(deployTarget.id, targetPackage.path)
          : deployIntent === 'upgrade' && selectedPackage !== undefined
            ? await api.upgrade(deployTarget.id, selectedPackage, downloadOptions)
            : deployIntent === 'test' && selectedPackage !== undefined
              ? await api.testUpgrade(deployTarget.id, selectedPackage, downloadOptions)
              : await api.deploy(deployTarget.id, selectedPackage ?? '')
      setDeployTarget(null)
      setError(null)
      setDeployJobs(current => [result.job, ...current.filter(job => job.id !== result.job.id)])
      openProgress(result.job)
      messageApi.info(`${deployIntent === 'upgrade' ? '升级' : deployIntent === 'test' ? '测试升级' : '部署'}已开始：${result.job.id}`)
    } catch (failure) {
      // The dialog closes only on success, so the reason has to be visible on
      // top of it; the page banner sits behind the mask.
      setError(errorText(failure))
      void messageApi.error(errorText(failure))
    } finally {
      setBusy('')
    }
  }, [deployIntent, deployTarget, downloadProxy, latestRelease, messageApi, openProgress, packageSource, selectedAsset, selectedPackage, selectedTargetPackage, targetPackages])

  const columns: ColumnsType<Member> = useMemo(() => {
    const actionColumn: ColumnsType<Member>[number] = {
      title: '操作',
      key: 'action',
      // 切换 + the 更多 icon need ~120px; the rest is headroom for the running
      // pill (spinner + "正在测试升级 62%"), which is the widest cell content.
      // The width is the same on every breakpoint: the table scrolls sideways
      // on a phone, so narrowing this column would only clip the pill.
      width: 170,
      align: 'right',
      render: (_value, member) => {
        // `queued` is the second between the panel writing the job and its
        // detached runner reporting in: it still owns the member.
        const activeJob = deployJobs.find(job => (job.status === 'running' || job.status === 'queued')
          && (job.member === member.id || job.target?.host === member.ip))
        if (activeJob !== undefined) {
          return (
            <Button
              size="small"
              icon={<LoadingOutlined />}
              title="查看升级进度；可在弹窗里取消升级"
              onClick={() => openProgress(activeJob)}
            >
              {activeJob.mode === 'upgrade' ? '正在升级' : activeJob.mode === 'test' ? '正在测试升级' : '正在部署'} {deployPercent(activeJob)}%
            </Button>
          )
        }
        // Every installed member can be upgraded from here, including other
        // members: the job runs in its own process, so restarting the target's
        // dsh / gate does not take this panel with it. A member that is not
        // installed yet still gets 首次安装 instead.
        const isSelf = member.kind === 'self'
        const installed = member.dsh || isSelf
        const canSwitch = member.dsh && gateAvailable && member.port !== null && member.id !== currentTarget
        return (
          <span className="dsh-pw-member-actions">
            {member.id === currentTarget ? <Tag color="blue">当前</Tag> : null}
            {canSwitch ? (
              <Button
                size="small"
                icon={<SwapOutlined />}
                loading={busy === member.id}
                onClick={() => { void switchMember(member) }}
              >
                切换
              </Button>
            ) : null}
            {installed ? (
              // Upgrade used to be one labelled button per path; with 版本 in
              // the table, three labels no longer fit next to 切换. Both paths
              // live under one icon-only menu instead.
              <Dropdown
                trigger={['click']}
                menu={{
                  items: isSelf
                    ? [
                        { key: 'upgrade', icon: <CloudUploadOutlined />, label: '升级' },
                        { key: 'auto', icon: <ClockCircleOutlined />, label: '自动升级' },
                      ]
                    : [
                        { key: 'upgrade', icon: <CloudUploadOutlined />, label: '升级' },
                        // On a Linux member 测试升级 first rehearses the flat
                        // path (what 升级 does on this machine) in a sandbox
                        // there; a Windows member has no flat install to
                        // rehearse, so its test upgrade is the real upgrade.
                        { key: 'test', icon: <ExperimentOutlined />, label: '测试升级' },
                        { key: 'auto', icon: <ClockCircleOutlined />, label: '自动升级' },
                      ],
                  onClick: ({ key }) => {
                    if (key === 'auto') {
                      setAutoUpgradeTarget(member)
                      return
                    }
                    openDeploy(member, key === 'test' ? 'test' : 'upgrade')
                  },
                }}
              >
                <Button
                  size="small"
                  icon={<EllipsisOutlined />}
                  aria-label="更多操作"
                  title={isSelf ? '更多：升级 / 自动升级' : '更多：升级 / 测试升级 / 自动升级'}
                  loading={busy === member.id}
                />
              </Dropdown>
            ) : null}
            {!installed ? (
              <Button
                size="small"
                icon={<CloudDownloadOutlined />}
                onClick={() => openDeploy(member, 'install')}
              >
                部署
              </Button>
            ) : null}
          </span>
        )
      },
    }
    const base: ColumnsType<Member> = [
      {
        title: '成员',
        key: 'member',
        width: screens.lg === true ? '15%' : 170,
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
        title: '版本',
        key: 'deployment',
        width: screens.lg === true ? '11%' : 120,
        render: (_value, member) => {
          const job = latestSucceededJobOf(member)
          const deployment = memberDeployment(member)
          const fallback = deployment === null ? packageDeployment(job) : null
          const version = deployment?.version ?? fallback?.version ?? null
          if (version === null) {
            return (
              <Tooltip title="还没有版本信息：这个成员的网关上报部署版本后会自动出现">
                <Typography.Text type="secondary">—</Typography.Text>
              </Tooltip>
            )
          }
          const stamp = deployment?.buildStamp ?? fallback?.buildStamp ?? null
          const inferred = deployment === null
          const packageName = (job?.package ?? '').split(/[\\/]/u).pop() ?? ''
          const details = [
            inferred
              ? `推断自最近一次成功的升级包${packageName === '' ? '' : `：${packageName}`}；成员网关上报部署版本后自动以它为准`
              : '这个成员正在运行的部署包',
            deployment?.builtAt !== null && deployment?.builtAt !== undefined
              ? `打包时间 ${new Date(deployment.builtAt).toLocaleString()}`
              : '',
            deployment?.release !== null && deployment?.release !== undefined ? `release ${deployment.release}` : '',
          ].filter(line => line !== '').join('\n')
          return (
            <Tooltip title={<pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>{details}</pre>}>
              <span className="dsh-pw-member-version">
                <Typography.Text className="dsh-pw-mono" style={{ fontSize: 12 }} type={inferred ? 'secondary' : undefined}>
                  {version}
                </Typography.Text>
                {stamp !== null ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>{stamp}</Typography.Text> : null}
              </span>
            </Tooltip>
          )
        },
      },
      {
        title: '标签',
        key: 'tag',
        width: screens.lg === true ? '10%' : 120,
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
        width: screens.lg === true ? '14%' : 190,
        responsive: ['sm'],
        render: (_value, member) => (
          <Space size={6} wrap>
            <Tag color={member.online ? 'green' : 'default'}>{member.online ? '在线' : '离线'}</Tag>
            {member.kind === 'self'
              ? <Tag color="blue">本机</Tag>
              : member.dsh
                ? (
                  <Tooltip title={member.probeStale === true ? '这次探测超时，显示的是最近一次成功的结果' : `DSH 在 ${String(member.port ?? '?')} 端口应答`}>
                    <Tag color={member.probeStale === true ? 'gold' : 'cyan'}>
                      DSH :{String(member.port ?? '?')}{member.probeStale === true ? '?' : ''}
                    </Tag>
                  </Tooltip>
                )
                : <Tag>未部署</Tag>}
            {member.latencyMs > 0 ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>{String(member.latencyMs)} ms</Typography.Text> : null}
          </Space>
        ),
      },
      {
        title: '系统',
        key: 'system',
        // Percentages plus the fixed action width must fit the card, or the
        // extra width becomes a horizontal scrollbar and the row actions stop
        // lining up with their header.
        width: screens.lg === true ? '21%' : 240,
        responsive: ['lg'],
        render: (_value, member) => (
          <Tooltip title={<pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>{systemDetails(member)}</pre>}>
            <Typography.Text className="dsh-pw-member-system" style={{ fontSize: 12 }}>{systemText(member)}</Typography.Text>
          </Tooltip>
        ),
      },
    ]
    return [...base, actionColumn]
  }, [busy, currentTarget, deployJobs, gateAvailable, latestSucceededJobOf, openDeploy, openProgress, openTag, screens, switchMember, tags])

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

  const selectedReleaseAsset = latestRelease?.assets.find(asset => asset.target === selectedAsset)
  const memberOs = deployTarget === null ? undefined : preferredTarget(deployTarget)
  const memberTarget = deployTarget === null ? undefined : memberTargetKey(deployTarget)
  const latestAssets = latestRelease === null
    ? []
    : latestRelease.assets.filter(asset => memberTarget !== undefined
      ? asset.target === memberTarget
      : memberOs === undefined || asset.os === memberOs)
  const deployReady = packageSource === 'latest'
    ? selectedReleaseAsset !== undefined && latestRelease?.ok === true
    : packageSource === 'target'
      ? selectedTargetPackage !== undefined
      : selectedPackage !== undefined
  const remoteTarget = deployTarget !== null && deployTarget.kind !== 'self' && deployTarget.id !== 'local'

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
          onChange={key => setPanelTab(key as 'members' | 'network' | 'packages')}
          tabBarExtraContent={panelTab === 'members' ? (
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
                  // A number (not undefined) is what makes rc-table wrap the
                  // grid in a horizontally scrollable content box. Below lg the
                  // minimum is the summed width of the columns still shown, so
                  // a phone keeps readable cells and scrolls instead of
                  // squashing them.
                  x: memberTableMinWidth(screens),
                  ...(memberRows.length > 8 ? { y: 'max(240px, calc(100vh - 320px))' } : {}),
                }}
                // Fixed layout honours the declared widths and the percentages
                // from the first row; with the x minimum above it is what keeps
                // the columns aligned instead of collapsing below lg.
                tableLayout="fixed"
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
              key: 'packages',
              label: '包管理',
              children: <PackagesPanel active={panelTab === 'packages'} members={memberRows} />,
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
                key: 'deployment',
                label: '部署版本',
                children: (() => {
                  const deployment = memberDeployment(detailTarget)
                  const fallback = deployment === null ? packageDeployment(latestSucceededJobOf(detailTarget)) : null
                  const version = deployment?.version ?? fallback?.version ?? null
                  if (version === null) return '—'
                  const stamp = deployment?.buildStamp ?? fallback?.buildStamp ?? null
                  return (
                    <Space size={6} wrap>
                      <Typography.Text className="dsh-pw-mono">{version}</Typography.Text>
                      {stamp !== null ? <Tag>{stamp}</Tag> : null}
                      {deployment === null ? <Tag color="gold">推断</Tag> : <Tag color="green">上报</Tag>}
                    </Space>
                  )
                })(),
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

      <AutoUpgradeModal member={autoUpgradeTarget} onClose={() => setAutoUpgradeTarget(null)} />

      <Modal
        open={deployTarget !== null}
        title={`${deployIntent === 'upgrade' ? '升级' : deployIntent === 'test' ? '测试升级' : '部署到'} ${deployTarget?.name ?? ''}`}
        okText={deployIntent === 'upgrade' ? '开始升级' : deployIntent === 'test' ? '开始测试升级' : '开始部署'}
        cancelText="取消"
        confirmLoading={busy !== ''}
        okButtonProps={{ disabled: !deployReady }}
        onCancel={() => setDeployTarget(null)}
        onOk={() => { void deploy() }}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {packageSource === 'latest'
              ? '升级包来自 latest tag：'
              : packageSource === 'target'
                ? (deployIntent === 'install' ? '部署包来自目标成员：' : '升级包来自目标成员：')
                : deployIntent === 'install' ? '部署包来自本机：' : '升级包来自本机：'}
            <span className="dsh-pw-mono">
              {packageSource === 'latest'
                ? 'GitHub / Gitee Release'
                : packageSource === 'target'
                  ? `${deployTarget?.system?.home ?? '目标成员'} · ~/.dsh/packages 或 ~/.dsh/mesh/upgrade`
                  : (packagesDir || '~/.dsh/packages')}
            </span>
          </Typography.Text>
          <Segmented
            block
            value={packageSource}
            onChange={value => setPackageSource(value as 'local' | 'latest' | 'target')}
            options={[
              {
                label: 'latest tag',
                value: 'latest',
                disabled: deployIntent !== 'upgrade',
              },
              {
                label: '目标成员已有包',
                value: 'target',
                disabled: !(remoteTarget && deployIntent !== 'test'),
              },
              { label: '本机部署包', value: 'local' },
            ]}
          />
          {deployIntent === 'install' ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              latest tag 只用于升级；新成员安装请选择本机部署包（目标成员已有包在安装时也可用）。
            </Typography.Text>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            目标安装目录：<span className="dsh-pw-mono">{memberAppRoot(deployTarget) || '沿用成员现有安装目录（部署时自动探测）'}</span>
            {deployTarget?.system?.home !== undefined && deployTarget.system.home !== ''
              ? `（~：${deployTarget.system.home}）`
              : ''}
          </Typography.Text>
          <Alert
            type="info"
            showIcon
            message={deployIntent === 'upgrade'
              ? (deployTarget?.kind === 'self' ? '本机升级会重启当前面板所在的服务' : '升级会重启这个成员的 dsh / gate')
              : deployIntent === 'test'
                ? '测试升级只影响这个成员，不会动本机'
                : '部署包会安装到成员上并启动服务'}
            description={deployIntent === 'test'
              ? (deployTarget !== null && preferredTarget(deployTarget) === 'windows'
                ? '这个成员是 Windows：它没有平铺安装可以演练，所以直接执行真实升级（prepare → activate → 健康检查），会重启它的服务。平铺演练只适用于 Linux 平铺安装（本机就是那种布局）。'
                : '两步：① 在沙箱里用该成员当前版本的插件和它真实的 gate.env／profile 清单搭一份平铺安装，跑与本机「升级」同源的平铺升级脚本（备份、覆盖、接线，再注入一次失败验证 restore），不碰成员的任何服务；② 演练通过后才按该成员自己的布局真实升级，并重启它的服务。演练失败会把任务停在失败上，成员保持原样。注意：单元重装与健康检查只在第②步跑，沙箱里跑不了。')
              : deployIntent === 'upgrade'
                ? (deployTarget?.kind === 'self'
                  ? '升级进程用 systemd 临时单元单独运行，dsh-web / gate 重启不会打断它；本页面会断开约 30–60 秒，之后自动恢复并显示升级结果。'
                  : '升级进程独立运行，本页面不受影响；成员切到新版本后会重启自己的 dsh / gate，健康检查失败时自动切回上一版。')
              : '部署包从本机上传到成员，安装完成后成员上的 dsh / gate / 控制服务会重启一次；进度在任务对话框里查看。'}
          />
          {deployIntent === 'upgrade' && remoteTarget && packageSource !== 'target' ? (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space size={6}>
                <Typography.Text type="secondary">下载代理</Typography.Text>
                <Select
                  size="small"
                  style={{ width: 260 }}
                  value={downloadProxy}
                  onChange={value => setDownloadProxy(value)}
                  options={[
                    { value: 'auto', label: '自动（有外网成员）' },
                    { value: 'none', label: '直连（成员自己联网）' },
                    ...(snapshot === null
                      ? []
                      : [snapshot.local, ...snapshot.members]
                        .filter(member => member.id !== 'local' && member.kind !== 'self' && member.online !== false
                          && String(member.system?.platform ?? '').toLowerCase().startsWith('linux'))
                        .map(member => ({
                          value: member.id,
                          label: [member.name, member.ip, member.tag ?? ''].filter(part => part !== '').join(' · '),
                        }))),
                  ]}
                />
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {packageSource === 'latest'
                  ? '成员自己下载：Gitee 优先直连；Gitee 不可用时回退 GitHub（GitHub 可经上面的成员代理）。网关不传输包体。'
                  : '本机包升级仍会先尝试 Release 下载（GitHub 优先）；失败后才把本机包上传到成员。'}
              </Typography.Text>
            </Space>
          ) : null}
          {deployTarget !== null ? (() => {
            const job = latestJobOf(deployTarget)
            if (job === undefined) return null
            return (
              <Space size={8} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近一次部署/升级：</Typography.Text>
                <Tag color={job.status === 'succeeded' ? 'success' : job.status === 'failed' ? 'error' : job.status === 'cancelled' ? 'default' : 'processing'}>
                  {job.status === 'succeeded' ? '成功' : job.status === 'failed' ? '失败' : job.status === 'cancelled' ? '已取消' : '进行中'}
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
          {packageSource === 'latest' ? (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {latestLoading ? (
                <Space size={6}>
                  <Spin size="small" />
                  <Typography.Text type="secondary">正在读取 latest tag…</Typography.Text>
                </Space>
              ) : null}
              {!latestLoading && latestError !== '' ? (
                <Alert
                  type={latestRelease?.ok === true ? 'warning' : 'error'}
                  showIcon
                  message={latestRelease?.stale === true ? '显示的是上次成功读取的发布清单' : '发布清单不可用'}
                  description={latestError}
                  action={deployTarget !== null ? (
                    <Button size="small" onClick={() => { void loadLatest(deployTarget, true) }}>重试</Button>
                  ) : null}
                />
              ) : null}
              {!latestLoading && latestRelease?.configured === false ? (
                <Alert
                  type="info"
                  showIcon
                  message="未配置 Release 发布"
                  description="到「包管理 → Release 发布」配置 token 后，才能从 latest tag 升级。"
                />
              ) : null}
              {latestRelease?.ok === true && latestAssets.length > 0 ? (
                <>
                  <Space size={6} wrap>
                    <Tag color="blue">{`v${latestRelease.version ?? '?'} / ${latestRelease.buildStamp ?? '?'}`}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {`清单来自 ${latestRelease.provider === 'gitee' ? 'Gitee' : 'GitHub'}`}
                      {latestRelease.publishedAt !== null ? ` · 发布于 ${new Date(latestRelease.publishedAt).toLocaleString()}` : ''}
                    </Typography.Text>
                    <Button
                      size="small"
                      type="text"
                      icon={<ReloadOutlined />}
                      loading={latestLoading}
                      onClick={() => { if (deployTarget !== null) void loadLatest(deployTarget, true) }}
                    >
                      刷新
                    </Button>
                  </Space>
                  {latestAssets.length > 1 ? (
                    <Select
                      style={{ width: '100%' }}
                      value={selectedAsset}
                      onChange={value => setSelectedAsset(value)}
                      options={latestAssets.map(asset => ({
                        value: asset.target,
                        label: `${asset.target}  ·  ${formatBytes(asset.bytes)}  ·  ${asset.providers.join(' / ')}`,
                      }))}
                    />
                  ) : null}
                  {selectedReleaseAsset !== undefined ? (
                    <Alert
                      type="info"
                      showIcon
                      message={`${selectedReleaseAsset.name}  ·  ${formatBytes(selectedReleaseAsset.bytes)}`}
                      description={`${deployTarget?.kind === 'self' || deployTarget?.id === 'local'
                        ? '由当前服务器下载并校验，然后就地升级并重启 dsh / gate'
                        : '目标成员自己下载'}：优先 Gitee，Gitee 不可用时回退 GitHub。SHA-256 ${selectedReleaseAsset.sha256.slice(0, 12)}…`}
                    />
                  ) : (
                    <Alert type="warning" showIcon message="这次发布没有该成员平台的包" />
                  )}
                </>
              ) : null}
              {!latestLoading && latestRelease?.ok === true && latestAssets.length === 0 ? (
                <Alert type="warning" showIcon message="这次发布没有该成员平台的部署包" />
              ) : null}
            </Space>
          ) : null}
          {packageSource === 'target' ? (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {targetPackagesLoading ? (
                <Space size={6}>
                  <Spin size="small" />
                  <Typography.Text type="secondary">正在读取目标成员的包…</Typography.Text>
                </Space>
              ) : null}
              {targetPackagesError !== '' ? (
                <Alert
                  type="error"
                  showIcon
                  message="读取目标成员的包失败"
                  description={targetPackagesError}
                  action={deployTarget !== null ? (
                    <Button size="small" onClick={() => { void loadTargetPackages(deployTarget, true) }}>重试</Button>
                  ) : null}
                />
              ) : null}
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  style={{ width: '100%' }}
                  loading={targetPackagesLoading}
                  value={selectedTargetPackage}
                  placeholder={targetPackages.length === 0 ? '目标成员上没有 dsh-mesh 包' : '选择目标成员上的包'}
                  onChange={value => setSelectedTargetPackage(value)}
                  options={targetPackages.map(item => ({
                    value: item.path,
                    label: `${item.name}  ·  ${item.os === 'windows' ? 'Windows' : 'Linux'}  ·  ${formatBytes(item.bytes)}`,
                  }))}
                />
                <Button
                  icon={<ReloadOutlined />}
                  loading={targetPackagesLoading}
                  onClick={() => { if (deployTarget !== null) void loadTargetPackages(deployTarget, true) }}
                >
                  刷新
                </Button>
              </Space.Compact>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                直接使用目标成员上的文件，不下载、不上传；开始升级时会在目标上重新计算 SHA-256。
              </Typography.Text>
              {!targetPackagesLoading && targetPackages.length === 0 && targetPackagesError === '' ? (
                <Alert
                  type="info"
                  showIcon
                  message="目标成员上没有可用包"
                  description="检查该成员的 ~/.dsh/packages 或 ~/.dsh/mesh/upgrade 目录。"
                />
              ) : null}
            </Space>
          ) : null}
          {packageSource === 'local' ? (
            <>
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
                  description="可以切换到「latest tag」或「目标成员已有包」，也可以把 .7z（或旧的 .tar.gz / .zip）放进本机 ~/.dsh/packages/ 后点刷新。"
                />
              ) : null}
            </>
          ) : null}
        </Space>
      </Modal>

      <Modal
        open={progressJob !== null}
        title={`${progressJob?.mode === 'upgrade' ? '升级' : progressJob?.mode === 'test' ? '测试升级' : '部署'}进度 · ${
          progressJob === null
            ? ''
            : memberRows.find(row => row.id === progressJob.member || row.ip === progressJob.target.host)?.name
              ?? progressJob.target.host
        }`}
        onCancel={() => setProgressJob(null)}
        footer={(
          <Space>
            {progressJob !== null && (progressJob.status === 'running' || progressJob.status === 'queued') ? (
              <Popconfirm
                title={`取消这次${deployAction(progressJob)}？`}
                description="停止升级进程并清理临时文件；成员保持在原版本。开始切换服务后不能取消。"
                okText="取消任务"
                cancelText="继续等待"
                okButtonProps={{ danger: true }}
                onConfirm={() => { void cancelDeployJob(progressJob) }}
              >
                <Button danger loading={cancelling === progressJob.id} icon={<StopOutlined />}>
                  取消{deployAction(progressJob)}
                </Button>
              </Popconfirm>
            ) : null}
            {progressJob !== null && progressJob.status === 'failed' && progressJob.member !== null && progressJob.member !== undefined && progressJob.member !== 'local'
              ? (
                <Popconfirm
                  title="把这个成员回滚到上一版？"
                  description="把 current 切回 previous 并重启它的服务；上一版不存在时会失败。"
                  okText="回滚"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => { void rollbackDeployJob(progressJob) }}
                >
                  <Button danger>回滚到上一版</Button>
                </Popconfirm>
              )
              : null}
            <Button onClick={() => setProgressJob(null)}>关闭</Button>
          </Space>
        )}
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
