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
  CloudDownloadOutlined,
  DeleteOutlined,
  ReloadOutlined,
  RocketOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { api, ApiError, type BuildJob, type Member, type PackageInfo } from './api'

const TARGET_OPTIONS = [
  { value: 'linux-x64', label: 'Linux x64' },
  { value: 'win-x64', label: 'Windows x64' },
]

/** Jobs older than this are still listed, but the panel stops polling them. */
const ACTIVE_STATUSES = new Set(['running', 'created'])

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
    default:
      return <Tag>{job.status}</Tag>
  }
}

function jobPercent(job: BuildJob): number {
  if (job.status === 'done') return 100
  if (typeof job.percent === 'number') return Math.max(0, Math.min(100, job.percent))
  if (job.status === 'failed' || job.status === 'needs-fix') return 100
  return 0
}

/** Member picker options: Linux members can build, everyone can proxy. */
function memberOptions(members: Member[], forBuild: boolean): Array<{ value: string, label: string, disabled?: boolean }> {
  const options = forBuild
    ? [{ value: 'local', label: '本机（网关）' }]
    : []
  for (const member of members) {
    const platform = String(member.system?.platform ?? '').toLowerCase()
    const linux = platform === '' || platform.startsWith('linux')
    const disabled = member.online === false || (forBuild && !linux)
    const bits = [member.name]
    if (member.ip !== '') bits.push(member.ip)
    if (member.online === false) bits.push('离线')
    else if (forBuild && !linux) bits.push(String(member.system?.platform ?? '非 Linux'))
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
  const [buildMember, setBuildMember] = useState('local')
  const [proxyMode, setProxyMode] = useState<'none' | 'member' | 'url'>('none')
  const [proxyMember, setProxyMember] = useState<string | undefined>(undefined)
  const [proxyUrl, setProxyUrl] = useState('')
  const [ref, setRef] = useState('master')
  const [targets, setTargets] = useState<string[]>(['linux-x64'])
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [logJob, setLogJob] = useState<BuildJob | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
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

  // A build takes minutes and the panel is the only progress display, so poll
  // while something runs and stop as soon as everything is settled.
  useEffect(() => {
    if (!active || !running) return
    const timer = setInterval(() => { void loadJobs() }, 3000)
    return () => clearInterval(timer)
  }, [active, running, loadJobs])

  // The log modal follows the same rule: live while the job runs, then stop.
  useEffect(() => {
    if (logJob === null) return
    let cancelled = false
    const load = async () => {
      setLogLoading(true)
      try {
        const result = await api.log(logJob.id, 300)
        if (!cancelled) setLogLines(result.lines)
      } catch {
        // A job that is still starting has no log yet.
      } finally {
        if (!cancelled) setLogLoading(false)
      }
    }
    void load()
    const timer = setInterval(() => {
      void load()
      void api.job(logJob.id).then(result => {
        if (!cancelled) {
          setLogJob(current => (current !== null && current.id === result.job.id ? result.job : current))
          setJobs(current => current.map(job => (job.id === result.job.id ? { ...job, ...result.job } : job)))
        }
      }).catch(() => {})
    }, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [logJob?.id])

  useEffect(() => {
    const node = logRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [logLines])

  const activeJob = logJob === null ? null : jobs.find(job => job.id === logJob.id) ?? logJob

  const start = useCallback(async () => {
    setError('')
    if (targets.length === 0) {
      setError('至少选择一个目标平台')
      return
    }
    if (proxyMode === 'member' && (proxyMember === undefined || proxyMember === '')) {
      setError('请选择代理成员')
      return
    }
    if (proxyMode === 'url' && proxyUrl.trim() === '') {
      setError('请填写代理地址')
      return
    }
    setStarting(true)
    try {
      const result = await api.startBuild({
        member: buildMember,
        ref: ref.trim() === '' ? undefined : ref.trim(),
        targets,
        ...(proxyMode === 'member' ? { proxyMember } : {}),
        ...(proxyMode === 'url' ? { proxy: proxyUrl.trim() } : {}),
      })
      messageApi.success(`已开始编译 ${result.job.id.slice(0, 16)}…`)
      await loadJobs()
      setLogJob(result.job)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setStarting(false)
    }
  }, [buildMember, messageApi, proxyMember, proxyMode, proxyUrl, ref, targets, loadJobs])

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
      render: (_value, job) => jobStatusTag(job),
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
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{(job.targets ?? []).join(' · ')}</Typography.Text>
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
            status={job.status === 'failed' ? 'exception' : job.status === 'done' ? 'success' : 'active'}
            showInfo={false}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{job.phase ?? ''}</Typography.Text>
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
                  value={buildMember}
                  onChange={setBuildMember}
                  options={memberOptions(members, true)}
                />
              </Space>
              <Space size={6}>
                <Typography.Text type="secondary">外网代理</Typography.Text>
                <Select
                  size="small"
                  style={{ width: 120 }}
                  value={proxyMode}
                  onChange={value => setProxyMode(value)}
                  options={[
                    { value: 'none', label: '直连' },
                    { value: 'member', label: '经成员' },
                    { value: 'url', label: '自定义' },
                  ]}
                />
                {proxyMode === 'member' ? (
                  <Select
                    size="small"
                    style={{ width: 200 }}
                    value={proxyMember}
                    placeholder="选择代理成员"
                    onChange={setProxyMember}
                    options={memberOptions(members, false)}
                  />
                ) : null}
                {proxyMode === 'url' ? (
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
            {buildMember === 'local' ? (
              <Alert
                type="info"
                showIcon
                message="本机内存较小时容易在 pnpm install 阶段被 OOM 终止；建议选择网络较好的成员编译，产物会自动拉回本机。"
              />
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                成员会用 GitHub main 的 dsh-mesh 检出运行同一套 code/build 引擎；产物拉回后出现在下方部署包列表。
              </Typography.Text>
            )}
            {proxyMode === 'member' ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                代理在所选成员上临时启动，只绑定它的组网地址，编译结束即关闭；经 WireGuard 转发通常比成员直连慢。
              </Typography.Text>
            ) : null}
            {error !== '' ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
          </Space>
        </Card>

        <Card size="small" title="编译任务" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>保留最近的任务与日志</Typography.Text>}>
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
        footer={<Button onClick={() => setLogJob(null)}>关闭</Button>}
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
              status={activeJob.status === 'failed' ? 'exception' : activeJob.status === 'done' ? 'success' : 'active'}
            />
            <pre className="dsh-pw-deploy-log" ref={logRef}>
              {logLines.length > 0 ? logLines.join('\n') : (logLoading ? '读取日志…' : '等待日志…')}
            </pre>
          </Space>
        )}
      </Modal>
    </div>
  )
}
