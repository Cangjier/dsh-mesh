import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
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
  CloudDownloadOutlined,
  EditOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import styles from './styles.css'
import { api, ApiError, type DeployJob, type Member, type PackageInfo, type Snapshot, type SystemInfo } from './api'
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
  if (error instanceof ApiError) return `${error.message}（HTTP ${String(error.status)}）`
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
  const uploadText = indeterminate
    ? `已上传 ${formatBytes(bytes)} / ${formatBytes(total)}（服务器不支持流式上传，无法显示百分比）`
    : `${formatBytes(bytes)} / ${formatBytes(total)}${speed > 0 ? ` · ${formatBytes(speed)}/s` : ''}${etaText(speed, total - bytes)}`
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space size={8} wrap>
        {running
          ? <Tag color="processing">部署中</Tag>
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
        <Typography.Text strong>上传安装包</Typography.Text>
        <Progress
          percent={percent}
          status={job.status === 'failed' ? 'exception' : percent >= 100 ? 'success' : 'active'}
          showInfo={!indeterminate}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{uploadText}</Typography.Text>
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
                  <Space size={8} style={{ width: '100%' }}>
                    <Progress percent={step.progress.percent} size="small" showInfo={false} style={{ width: 160 }} />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {step.progress.done} / {step.progress.total}
                    </Typography.Text>
                  </Space>
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

function Panel({ ctx }: { ctx: any }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [gateAvailable, setGateAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
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
  const [panelTab, setPanelTab] = useState<'members' | 'network'>('members')
  const [tags, setTags] = useState<Record<string, string>>({})
  const [tagTarget, setTagTarget] = useState<Member | null>(null)
  const [detailTarget, setDetailTarget] = useState<Member | null>(null)
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
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

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
      setError(errorText(failure))
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
      width: screens.lg === true ? '11%' : 120,
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
              正在部署
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
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void load() }}>刷新</Button>
          </div>
        </div>

        {error !== null ? (
          <div className="dsh-pw-error">
          <Alert
            type="error"
            showIcon
            closable
            message="操作失败"
            description={error}
            onClose={() => setError(null)}
            style={{ marginBottom: 14 }}
          />
          </div>
        ) : null}

        <Tabs
          className="dsh-pw-tabs"
          activeKey={panelTab}
          onChange={key => setPanelTab(key as 'members' | 'network')}
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
                  x: screens.lg === true ? 900 : undefined,
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
              key: 'network',
              label: '组网',
              children: <div className="dsh-pw-tabbody"><WireGuardPanel ctx={ctx} embedded /></div>,
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
        footer={<Button onClick={() => setDetailTarget(null)}>关闭</Button>}
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
