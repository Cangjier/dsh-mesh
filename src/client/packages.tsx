/**
 * 包管理 tab: build on a member and manage the packages the gateway can deploy.
 *
 * The build itself is the deterministic engine (`code/build`); this panel only
 * chooses *where* it runs and *through what* it downloads. Keeping those two
 * knobs explicit is the point: a member near GitHub produces the package, and
 * a member with better internet can be borrowed as the outbound proxy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ClearOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  RocketOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { api, ApiError, type BuildJob, type Member, type PackageInfo } from './api'
import { useEventStream } from './events'
import { ScheduleCard } from './schedule'
import {
  DEFAULT_BUILD_TARGETS,
  memberCores,
  memberMemoryBytes,
  pickBuildMember,
  pickProxyMember,
} from '../lib/build-defaults.mjs'

const TARGET_OPTIONS = [
  { value: 'linux-x64', label: 'Linux x64' },
  { value: 'win-x64', label: 'Windows x64' },
]

/** Statuses that still own the single build slot. */
const ACTIVE_STATUSES = new Set(['running', 'created'])

/**
 * Merge pushed job snapshots into the table.
 *
 * Events can arrive out of order after a reconnect; the newer `updatedAt` wins
 * so a stale frame can never roll the table back.
 * @param previous current rows.
 * @param incoming pushed rows.
 * @returns rows newest first.
 */
function mergeJobs(previous: BuildJob[], incoming: BuildJob[]): BuildJob[] {
  const byId = new Map(previous.map(job => [job.id, job] as const))
  for (const job of incoming) {
    const existing = byId.get(job.id)
    if (existing === undefined || String(job.updatedAt ?? '') >= String(existing.updatedAt ?? '')) byId.set(job.id, job)
  }
  return [...byId.values()].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
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

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（HTTP ${String(error.status)}）`
  return error instanceof Error ? error.message : String(error)
}

function jobStatusTag(job: BuildJob): JSX.Element {
  switch (job.status) {
    case 'running':
    case 'created':
      return <Tag color="processing">编译中</Tag>
    case 'done':
      return <Tag color="success">完成</Tag>
    case 'needs-fix':
      return <Tag color="warning">待适配</Tag>
    case 'planned':
      return <Tag color="default">仅计划</Tag>
    case 'failed':
    case 'build-failed':
      return <Tag color="error">失败</Tag>
    case 'smoke-failed':
      return <Tag color="error">抓屏失败</Tag>
    default:
      return <Tag>{job.status}</Tag>
  }
}

/**
 * The browser check that ran after packaging, if the job carries one.
 *
 * A done job with a passed smoke test is the only combination that says the
 * archive was actually started and its UI rendered; "未抓屏" is deliberately
 * visible instead of silently looking like a verified build.
 * @param job build job.
 * @returns status tag or null.
 */
function smokeTag(job: BuildJob): JSX.Element | null {
  const results = (job.artifacts ?? [])
    .map(artifact => artifact.smoke)
    .filter((smoke): smoke is NonNullable<typeof smoke> => smoke !== undefined && smoke !== null)
  if (results.length === 0) return null
  if (results.some(smoke => smoke.status === 'failed')) return <Tag color="error">抓屏失败</Tag>
  const passed = results.filter(smoke => smoke.status === 'passed')
  if (passed.length > 0) {
    const shots = passed.flatMap(smoke => smoke.screenshots ?? []).join('\n')
    return <Tooltip title={shots === '' ? 'headless Chrome 已确认 DSH 启动且 Mesh 面板出现' : shots}><Tag color="green">抓屏通过</Tag></Tooltip>
  }
  const reason = results.map(smoke => smoke.reason).filter(Boolean).join('；')
  return <Tooltip title={reason === '' ? '这个任务没有执行抓屏' : reason}><Tag>未抓屏</Tag></Tooltip>
}

function jobPercent(job: BuildJob): number {
  if (job.status === 'done') return 100
  // A stopped job keeps the percentage it actually reached. Forcing 100 made a
  // failure during packaging look like a finished build with a red bar.
  if (typeof job.percent === 'number') return Math.max(0, Math.min(100, job.percent))
  return 0
}

/** Chinese name for the engine's phase identifiers. */
function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case 'created': return '已创建'
    case 'prepare': return '准备源码'
    case 'apply': return '应用补丁'
    case 'build': return '构建 Web'
    case 'package': return '打包'
    case 'smoke': return '抓屏验证'
    case 'fetch': return '拉取产物'
    case 'done': return '完成'
    case 'failed': return '失败'
    default: return phase ?? ''
  }
}

/** The target being packaged, with its position when the job has several. */
function targetText(job: BuildJob): string {
  const target = job.currentTarget ?? ''
  if (target === '') return ''
  const targets = job.targets ?? []
  const index = targets.indexOf(target)
  return index >= 0 && targets.length > 1 ? `${target}（${String(index + 1)}/${String(targets.length)}）` : target
}

/** Capacity suffix shown for a build member so the default is self-explanatory. */
function resourceBits(member: Member): string[] {
  const bits: string[] = []
  const cores = memberCores(member)
  if (cores > 0) bits.push(`${String(cores)} 核`)
  const memory = memberMemoryBytes(member)
  if (memory > 0) bits.push(formatBytes(memory))
  return bits
}

/**
 * Member picker options.
 *
 * Any online Linux or Windows member can build; the proxy member must be Linux
 * because the egress proxy is started with `bash -s`. The local gateway is not
 * a proxy candidate: a machine cannot proxy its own build.
 */
function memberOptions(members: Member[], forBuild: boolean): Array<{ value: string, label: string, disabled?: boolean }> {
  const options: Array<{ value: string, label: string, disabled?: boolean }> = []
  if (forBuild) {
    const local = members.find(member => member.id === 'local')
    options.push({
      value: 'local',
      label: ['本机（网关）', ...(local === undefined ? [] : resourceBits(local))].join(' · '),
    })
  }
  for (const member of members) {
    // The local row is already offered (or excluded) above.
    if (member.id === 'local') continue
    const platform = String(member.system?.platform ?? '').toLowerCase()
    const supported = platform === '' || platform.startsWith('linux') || platform.startsWith('win')
    const linux = platform === '' || platform.startsWith('linux')
    const disabled = member.online === false || (forBuild && !supported) || (!forBuild && !linux)
    const bits = [member.name]
    if (member.ip !== '') bits.push(member.ip)
    if (forBuild) bits.push(...resourceBits(member))
    else if (typeof member.countryCode === 'string' && member.countryCode !== '') bits.push(member.countryCode.toUpperCase())
    if (platform.startsWith('win')) bits.push('Windows')
    if (member.online === false) bits.push('离线')
    else if (forBuild && !supported) bits.push(String(member.system?.platform ?? '不支持'))
    else if (!forBuild && !linux) bits.push('仅 Linux 可做代理')
    options.push({ value: member.id, label: bits.join(' · '), ...(disabled ? { disabled: true } : {}) })
  }
  return options
}

export function PackagesPanel({ members, active }: { members: Member[]; active: boolean }) {
  const [messageApi, contextHolder] = message.useMessage()
  const [packages, setPackages] = useState<PackageInfo[]>([])
  const [packagesDir, setPackagesDir] = useState('')
  const [packagesLoading, setPackagesLoading] = useState(false)
  const [packagesError, setPackagesError] = useState('')
  const [jobs, setJobs] = useState<BuildJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)
  // `null` means "follow the member list": the panel preselects the richest
  // build member and a foreign proxy member as soon as discovery lands, while
  // a value the operator picked is never overwritten.
  const [buildMember, setBuildMember] = useState<string | null>(null)
  const [proxyMode, setProxyMode] = useState<'none' | 'member' | 'url' | null>(null)
  const [proxyMember, setProxyMember] = useState<string | null>(null)
  const [proxyUrl, setProxyUrl] = useState('')
  const [ref, setRef] = useState('master')
  const [targets, setTargets] = useState<string[]>([...DEFAULT_BUILD_TARGETS])
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [logJob, setLogJob] = useState<BuildJob | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [logCleared, setLogCleared] = useState(false)
  const [logLoading, setLogLoading] = useState(false)
  const logRef = useRef<HTMLPreElement | null>(null)

  const loadPackages = useCallback(async () => {
    setPackagesLoading(true)
    setPackagesError('')
    try {
      const result = await api.packages()
      setPackages(result.packages)
      setPackagesDir(result.dir)
    } catch (failure) {
      setPackagesError(errorText(failure))
      setPackages([])
    } finally {
      setPackagesLoading(false)
    }
  }, [])

  const loadJobs = useCallback(async () => {
    setJobsLoading(true)
    try {
      const result = await api.jobs()
      setJobs(Array.isArray(result.jobs) ? result.jobs : [])
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setJobsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void loadPackages()
    void loadJobs()
  }, [active, loadPackages, loadJobs])

  const running = useMemo(() => jobs.some(job => ACTIVE_STATUSES.has(job.status)), [jobs])

  // Defaults are derived, not copied into state: members arrive after the
  // panel mounts, so a state initializer would freeze on "本机 / 直连".
  const defaultBuildMember = useMemo(() => pickBuildMember(members), [members])
  const defaultProxyMember = useMemo(() => pickProxyMember(members), [members])
  const selectedBuildMember = buildMember ?? defaultBuildMember
  const selectedProxyMode = proxyMode ?? (defaultProxyMember === null ? 'none' : 'member')
  const selectedProxyMember = proxyMember ?? defaultProxyMember ?? undefined

  // One SSE connection carries every build change and log tail; there is no
  // timer and no request while nothing happens. `ready` fires on connect and
  // after every reconnect, which is where the panel resyncs.
  useEventStream(active ? '/api/dsh-mesh/events' : null, event => {
    const type = event.type ?? ''
    if (type === 'ready') {
      // Connect/reconnect: resync the table and the open log once.
      void loadJobs()
      if (logJob !== null) {
        void api.log(logJob.id, 300).then(result => setLogLines(result.lines)).catch(() => {})
      }
      return
    }
    if (type === 'build' && event.job !== undefined) {
      const job = event.job as unknown as BuildJob
      setJobs(previous => mergeJobs(previous, [job]))
      setLogJob(current => (current !== null && current.id === job.id ? job : current))
      return
    }
    if (type === 'build-log' && logJob !== null && event.id === logJob.id) {
      const lines = Array.isArray(event.lines) ? event.lines.filter(line => typeof line === 'string') : []
      // A running job's log cannot be cleared (the button is disabled), so an
      // empty tail is a stale or broken frame and must not wipe the modal.
      const stillRunning = (jobs.find(job => job.id === logJob.id)?.status ?? logJob.status) === 'running'
      if (lines.length === 0 && stillRunning && logLines.length > 0) return
      setLogLines(lines)
    }
  })

  // The log modal reads one tail when it opens; later lines arrive above.
  useEffect(() => {
    if (logJob === null) return
    let cancelled = false
    setLogLoading(true)
    void api.log(logJob.id, 300).then(result => {
      if (!cancelled) setLogLines(result.lines)
    }).catch(() => {
      // A job that is still starting has no log yet.
    }).finally(() => {
      if (!cancelled) setLogLoading(false)
    })
    return () => { cancelled = true }
  }, [logJob?.id])

  useEffect(() => {
    const node = logRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [logLines])

  const activeJob = logJob === null ? null : jobs.find(job => job.id === logJob.id) ?? logJob
  // A log file can be one empty line after a clear; that is not content.
  const visibleLines = logLines.filter(line => line.trim() !== '')

  const start = useCallback(async () => {
    setError('')
    if (targets.length === 0) {
      setError('至少选择一个目标平台')
      return
    }
    if (selectedProxyMode === 'member' && (selectedProxyMember === undefined || selectedProxyMember === '')) {
      setError('请选择代理成员')
      return
    }
    if (selectedProxyMode === 'url' && proxyUrl.trim() === '') {
      setError('请填写代理地址')
      return
    }
    setStarting(true)
    try {
      const result = await api.startBuild({
        member: selectedBuildMember,
        ref: ref.trim() === '' ? undefined : ref.trim(),
        targets,
        ...(selectedProxyMode === 'member' ? { proxyMember: selectedProxyMember } : {}),
        ...(selectedProxyMode === 'url' ? { proxy: proxyUrl.trim() } : {}),
      })
      messageApi.success(`已开始编译 ${result.job.id.slice(0, 16)}…`)
      await loadJobs()
      setLogJob(result.job)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setStarting(false)
    }
  }, [messageApi, proxyUrl, ref, selectedBuildMember, selectedProxyMember, selectedProxyMode, targets, loadJobs])

  /**
   * Truncate one finished job's log.
   *
   * The log is where a failed build explains itself, so a running job keeps
   * its log; the button stays enabled for a finished job even when the log is
   * already empty, so a click always answers instead of silently doing nothing.
   */
  const clearLog = useCallback(async () => {
    if (logJob === null) return
    const hadLines = logLines.some(line => line.trim() !== '')
    try {
      await api.clearBuildLog(logJob.id)
      setLogLines([])
      setLogCleared(true)
      messageApi.success(hadLines ? '日志已清空' : '日志本来就是空的')
    } catch (failure) {
      messageApi.error(errorText(failure))
    }
  }, [logJob, logLines, messageApi])

  /**
   * Remove every finished job in one go (the card's toolbar button).
   *
   * The server deletes the job directory, so the table really empties: a
   * truncation-only clear left the rows in place and looked like nothing had
   * happened. An open log dialog is closed only when its job went away.
   */
  const clearAllLogs = useCallback(async () => {
    try {
      const result = await api.clearBuildLogs()
      if (logJob !== null && result.cleared.includes(logJob.id)) {
        setLogLines([])
        setLogCleared(false)
        setLogJob(null)
      }
      messageApi.success(result.cleared.length === 0 ? '没有已结束的任务可清理' : `已清理 ${String(result.cleared.length)} 个任务`)
      await loadJobs()
    } catch (failure) {
      messageApi.error(errorText(failure))
    }
  }, [loadJobs, logJob, messageApi])

  const remove = useCallback(async (name: string) => {
    try {
      await api.removePackage(name)
      messageApi.success(`已删除 ${name}`)
      await loadPackages()
    } catch (failure) {
      messageApi.error(errorText(failure))
    }
  }, [loadPackages, messageApi])

  const jobColumns: ColumnsType<BuildJob> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (_value, job) => (
        <Space size={4} wrap>
          {jobStatusTag(job)}
          {job.status === 'done' ? smokeTag(job) : null}
        </Space>
      ),
    },
    {
      title: '成员',
      dataIndex: 'memberName',
      width: 150,
      render: (_value, job) => (
        <Typography.Text ellipsis style={{ maxWidth: 140 }}>
          {job.mode === 'remote' ? (job.memberName ?? job.member ?? '成员') : '本机'}
        </Typography.Text>
      ),
    },
    {
      title: '引用 / 目标',
      dataIndex: 'ref',
      render: (_value, job) => (
        <Space direction="vertical" size={0}>
          <span className="dsh-pw-mono" style={{ fontSize: 12 }}>{job.ref}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{(job.targets ?? []).join(' · ')}{job.buildStamp ? ` · ${job.buildStamp}` : ''}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '进度',
      dataIndex: 'percent',
      width: 160,
      render: (_value, job) => (
        <Space direction="vertical" size={0} style={{ width: '100%' }}>
          <Progress
            percent={jobPercent(job)}
            size="small"
            status={job.status === 'failed' || job.status === 'build-failed' || job.status === 'smoke-failed' ? 'exception' : job.status === 'done' ? 'success' : 'active'}
            showInfo={false}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[phaseLabel(job.phase), targetText(job)].filter(part => part !== '').join(' · ')}
            {job.status === 'running' || job.status === 'created' ? ` · ${String(jobPercent(job))}%` : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '开始时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (_value, job) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {job.createdAt === undefined ? '—' : new Date(job.createdAt).toLocaleString()}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_value, job) => (
        <Button
          type="link"
          size="small"
          onClick={() => {
            setLogLines([])
            setLogCleared(false)
            setLogJob(job)
          }}
        >
          日志
        </Button>
      ),
    },
  ]

  const packageColumns: ColumnsType<PackageInfo> = [
    {
      title: '部署包',
      dataIndex: 'name',
      render: (name: string) => <span className="dsh-pw-mono" style={{ fontSize: 12 }}>{name}</span>,
    },
    {
      title: '平台',
      dataIndex: 'target',
      width: 100,
      render: (value: PackageInfo['target']) => (
        <Tag color={value === 'windows' ? 'blue' : 'geekblue'}>{value === 'windows' ? 'Windows' : 'Linux'}</Tag>
      ),
    },
    {
      title: '大小',
      dataIndex: 'bytes',
      width: 110,
      render: (value: number) => formatBytes(value),
    },
    {
      title: '时间',
      dataIndex: 'mtime',
      width: 170,
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(value).toLocaleString()}</Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_value, item) => (
        <Popconfirm
          title="删除这个部署包？"
          description={item.name}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => { void remove(item.name) }}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div className="dsh-pw-tabbody">
      {contextHolder}
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Card
          size="small"
          title={<Space size={6}><ThunderboltOutlined />编译</Space>}
          extra={(
            <Tooltip title="刷新编译任务与部署包">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={jobsLoading || packagesLoading}
                onClick={() => { void loadJobs(); void loadPackages() }}
              />
            </Tooltip>
          )}
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space size={16} wrap>
              <Space size={6}>
                <Typography.Text type="secondary">编译成员</Typography.Text>
                <Select
                  size="small"
                  style={{ width: 220 }}
                  value={selectedBuildMember}
                  onChange={value => setBuildMember(value)}
                  options={memberOptions(members, true)}
                />
              </Space>
              <Space size={6}>
                <Typography.Text type="secondary">外网代理</Typography.Text>
                <Select
                  size="small"
                  style={{ width: 120 }}
                  value={selectedProxyMode}
                  onChange={value => setProxyMode(value)}
                  options={[
                    { value: 'none', label: '直连' },
                    { value: 'member', label: '经成员' },
                    { value: 'url', label: '自定义' },
                  ]}
                />
                {selectedProxyMode === 'member' ? (
                  <Select
                    size="small"
                    style={{ width: 230 }}
                    value={selectedProxyMember}
                    placeholder="选择代理成员"
                    onChange={value => setProxyMember(value)}
                    options={memberOptions(members, false)}
                  />
                ) : null}
                {selectedProxyMode === 'url' ? (
                  <Input
                    size="small"
                    style={{ width: 220 }}
                    value={proxyUrl}
                    placeholder="http://host:port"
                    onChange={event => setProxyUrl(event.target.value)}
                  />
                ) : null}
              </Space>
            </Space>
            <Space size={16} wrap>
              <Space size={6}>
                <Typography.Text type="secondary">源码引用</Typography.Text>
                <Input
                  size="small"
                  style={{ width: 220 }}
                  value={ref}
                  placeholder="master / 提交号"
                  onChange={event => setRef(event.target.value)}
                />
              </Space>
              <Space size={6}>
                <Typography.Text type="secondary">目标平台</Typography.Text>
                <Select
                  size="small"
                  mode="multiple"
                  style={{ minWidth: 240 }}
                  value={targets}
                  onChange={values => setTargets(values)}
                  options={TARGET_OPTIONS}
                />
              </Space>
              <Button
                type="primary"
                size="small"
                icon={<RocketOutlined />}
                loading={starting}
                disabled={running}
                onClick={() => { void start() }}
              >
                编译
              </Button>
            </Space>
            {error !== '' ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
          </Space>
        </Card>

        <ScheduleCard active={active} />

        <Card
          size="small"
          title="编译任务"
          extra={(
            <Space size={10}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>保留最近的任务与日志</Typography.Text>
              <Popconfirm
                title="清空所有已结束的任务？"
                description="任务记录、日志和编译工作目录会一起删除；部署包与正在编译的任务不受影响。"
                okText="清空"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => { void clearAllLogs() }}
              >
                <Button size="small" type="text" danger icon={<ClearOutlined />}>清空日志</Button>
              </Popconfirm>
            </Space>
          )}
        >
          <Table<BuildJob>
            rowKey="id"
            size="small"
            loading={jobsLoading && jobs.length === 0}
            dataSource={jobs}
            columns={jobColumns}
            pagination={jobs.length > 6 ? { pageSize: 6, hideOnSinglePage: true, size: 'small' } : false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有编译任务" /> }}
          />
        </Card>

        <Card
          size="small"
          title={<Space size={6}><CloudDownloadOutlined />部署包</Space>}
          extra={(
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <span className="dsh-pw-mono">{packagesDir === '' ? '~/.dsh/packages' : packagesDir}</span>
            </Typography.Text>
          )}
        >
          {packagesError !== '' ? <Alert type="error" showIcon message={packagesError} style={{ marginBottom: 10 }} /> : null}
          <Table<PackageInfo>
            rowKey="name"
            size="small"
            loading={packagesLoading && packages.length === 0}
            dataSource={packages}
            columns={packageColumns}
            pagination={packages.length > 8 ? { pageSize: 8, hideOnSinglePage: true, size: 'small' } : false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有部署包" /> }}
          />
        </Card>
      </Space>

      <Modal
        open={logJob !== null}
        title={`编译日志 · ${logJob?.id.slice(0, 24) ?? ''}`}
        width={820}
        footer={(
          <Space>
            <Popconfirm
              title="清空这个任务的日志？"
              description={activeJob?.status === 'running' ? '编译还在运行，结束后才能清空。' : '只清空日志文件，任务记录保留；要连同记录一起清掉用卡片右上角的清空日志。'}
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={activeJob === null || activeJob.status === 'running'}
              onConfirm={() => { void clearLog() }}
            >
              <Button danger disabled={activeJob === null || activeJob.status === 'running'}>清空日志</Button>
            </Popconfirm>
            <Button onClick={() => setLogJob(null)}>关闭</Button>
          </Space>
        )}
        onCancel={() => setLogJob(null)}
        destroyOnHidden
      >
        {activeJob === null ? null : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space size={8} wrap>
              {jobStatusTag(activeJob)}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {activeJob.mode === 'remote' ? `成员 ${activeJob.memberName ?? activeJob.member ?? ''}` : '本机'}
                {activeJob.proxy === null || activeJob.proxy === undefined || activeJob.proxy === '' ? ' · 直连' : ` · 代理 ${activeJob.proxy}`}
              </Typography.Text>
              {activeJob.error !== null && activeJob.error !== undefined && activeJob.error !== '' ? (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>{activeJob.error}</Typography.Text>
              ) : null}
            </Space>
            <Progress
              percent={jobPercent(activeJob)}
              size="small"
              status={activeJob.status === 'failed' || activeJob.status === 'build-failed' ? 'exception' : activeJob.status === 'done' ? 'success' : 'active'}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {[phaseLabel(activeJob.phase), targetText(activeJob)].filter(part => part !== '').join(' · ')}
            </Typography.Text>
            <pre className="dsh-pw-deploy-log" ref={logRef}>
              {visibleLines.length > 0 ? visibleLines.join('\n') : logCleared ? '日志已清空' : logLoading ? '读取日志…' : activeJob.status === 'running' ? '等待日志…' : '这个任务没有日志'}
            </pre>
          </Space>
        )}
      </Modal>
    </div>
  )
}
