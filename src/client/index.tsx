import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Descriptions,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
  theme as antdTheme,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApartmentOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  ReloadOutlined,
  RocketOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import styles from './styles.css'
import { api, ApiError, type BuildJob, type HostStatus, type Member, type Snapshot } from './api'

const NS = 'dsh-person-web'
const PANEL_ID = 'person-web'
const TARGET_OPTIONS = [
  { value: 'linux-x64', label: 'Linux x64' },
  { value: 'win-x64', label: 'Windows x64' },
  { value: 'linux-arm64', label: 'Linux arm64' },
]
const DEFAULT_SOURCE = 'https://github.com/deepseek-ai/deepseek-harness'

function useThemeMode(ctx: any): 'light' | 'dark' {
  const [snapshot, setSnapshot] = useState<any>(() => ctx.theme.getTheme())
  useEffect(() => ctx.on('theme/change', (next: any) => setSnapshot(next)), [ctx])
  return snapshot?.active?.colorScheme === 'dark' ? 'dark' : 'light'
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（HTTP ${String(error.status)}）`
  return error instanceof Error ? error.message : String(error)
}

function statusColor(status: string): string {
  if (status === 'done') return 'success'
  if (status === 'running' || status === 'created' || status === 'planned') return 'processing'
  if (status === 'needs-fix') return 'warning'
  if (status === 'failed' || status === 'build-failed') return 'error'
  return 'default'
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    created: '已创建',
    running: '运行中',
    planned: '检查通过',
    'needs-fix': '需要修复',
    'build-failed': '构建失败',
    done: '完成',
    failed: '失败',
  }
  return map[status] ?? status
}

function Panel({ ctx }: { ctx: any }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [host, setHost] = useState<HostStatus | null>(null)
  const [gateAvailable, setGateAvailable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState('members')
  const [source, setSource] = useState('')
  const [ref, setRef] = useState('')
  const [targets, setTargets] = useState<string[]>(['linux-x64', 'win-x64'])
  const [jobs, setJobs] = useState<BuildJob[]>([])
  const [job, setJob] = useState<BuildJob | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  const [buildBusy, setBuildBusy] = useState('')
  const [messageApi, contextHolder] = message.useMessage()
  const mode = useThemeMode(ctx)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const gate = await api.gateStatus()
      if (gate !== null) {
        setGateAvailable(true)
        setSnapshot(gate)
        setHost(null)
      } else {
        setGateAvailable(false)
        const [status, members] = await Promise.all([api.hostStatus(), api.hostMembers()])
        setHost(status)
        setSnapshot({ ...members, target: 'local' })
      }
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadJobs = useCallback(async () => {
    try {
      const result = await api.jobs()
      setJobs(result.jobs)
    } catch {
      // A panel opened through a gate whose host plugin is older simply has no
      // job API; the member tab still works.
    }
  }, [])

  useEffect(() => {
    void load()
    void loadJobs()
  }, [load, loadJobs])

  useEffect(() => {
    if (job === null) return
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = async () => {
      try {
        const result = await api.job(job.id)
        if (!alive) return
        setJob(result.job)
        const log = await api.log(job.id, 120)
        if (alive) setLogLines(log.lines)
      } catch {
        // A transient read failure keeps the last snapshot on screen.
      }
    }
    if (job.running === true || ['created', 'running'].includes(job.status)) {
      timer = setInterval(() => { void tick() }, 2500)
    }
    return () => {
      alive = false
      if (timer !== undefined) clearInterval(timer)
    }
  }, [job?.id, job?.status, job?.running])

  const currentTarget = snapshot?.target ?? 'local'
  const memberRows = useMemo(() => {
    if (snapshot === null) return []
    const local = snapshot.local ?? (snapshot as unknown as { self?: Member }).self
    const peers = snapshot.members.filter(member => member.id !== 'local')
    return local ? [local, ...peers] : peers
  }, [snapshot])
  const targetMember = useMemo(
    () => memberRows.find(member => member.id === currentTarget) ?? null,
    [memberRows, currentTarget],
  )

  const select = useCallback(async (id: string) => {
    if (!gateAvailable) {
      messageApi.warning('当前页面不是通过网关访问的，成员切换不可用。')
      return
    }
    setBusy(id)
    try {
      await api.gateSelect(id)
      window.location.reload()
    } catch (failure) {
      setError(errorText(failure))
      setBusy('')
    }
  }, [gateAvailable, messageApi])

  const refreshJob = useCallback(async (id: string) => {
    try {
      const result = await api.job(id)
      setJob(result.job)
      const log = await api.log(id, 120)
      setLogLines(log.lines)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [])

  const chooseJob = useCallback(async (id: string) => {
    const found = jobs.find(candidate => candidate.id === id)
    if (found === undefined) return
    setJob(found)
    await refreshJob(id)
  }, [jobs, refreshJob])

  const startBuild = useCallback(async (planOnly: boolean) => {
    setBuildBusy(planOnly ? 'plan' : 'build')
    try {
      const result = await api.startBuild({
        source: source.trim() === '' ? undefined : source.trim(),
        ref: ref.trim() === '' ? undefined : ref.trim(),
        targets,
        planOnly,
      })
      setJob(result.job)
      setLogLines([])
      setTab('build')
      await loadJobs()
      await refreshJob(result.job.id)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBuildBusy('')
    }
  }, [source, ref, targets, loadJobs, refreshJob])

  const learn = useCallback(async () => {
    if (job === null) return
    setBuildBusy('learn')
    try {
      await api.learn(job.id)
      await refreshJob(job.id)
      await loadJobs()
      messageApi.success('已把工作树里的修改收成覆盖层。')
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBuildBusy('')
    }
  }, [job, refreshJob, loadJobs, messageApi])

  const resume = useCallback(async () => {
    if (job === null) return
    setBuildBusy('resume')
    try {
      const result = await api.resume(job.id)
      setJob(result.job)
      await loadJobs()
      await refreshJob(job.id)
      messageApi.success('已继续构建，复用现有工作树。')
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBuildBusy('')
    }
  }, [job, refreshJob, loadJobs, messageApi])

  const columns: ColumnsType<Member> = [
    {
      title: '成员',
      dataIndex: 'name',
      render: (_value, member) => (
        <Space size={6}>
          {member.kind === 'self' ? <Tag color="blue">本机</Tag> : <CloudServerOutlined />}
          <span>{member.name}</span>
        </Space>
      ),
    },
    {
      title: '地址 / id',
      dataIndex: 'id',
      render: value => <span className={"dsh-pw-mono"}>{value}</span>,
    },
    {
      title: '状态',
      width: 210,
      render: (_value, member) => (
        <Space size={4} wrap>
          <Tag color={member.online ? 'green' : 'default'}>{member.online ? '在线' : '离线'}</Tag>
          {member.dsh
            ? <Tag color="cyan">DSH :{member.port}</Tag>
            : <Tag>未部署 / 不可达</Tag>}
        </Space>
      ),
    },
    {
      title: '延迟',
      dataIndex: 'latencyMs',
      width: 90,
      render: value => (typeof value === 'number' && value > 0 ? `${String(value)} ms` : '—'),
    },
    {
      title: '操作',
      width: 120,
      render: (_value, member) => {
        if (member.id === currentTarget) return <Tag color="processing">当前</Tag>
        return (
          <Button
            size="small"
            disabled={!gateAvailable || busy !== ''}
            loading={busy === member.id}
            onClick={() => { void select(member.id) }}
          >
            {member.id === 'local' ? '返回本机' : '切换'}
          </Button>
        )
      },
    },
  ]

  const memberTab = (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      {!gateAvailable ? (
        <Alert
          type="info"
          showIcon
          message="当前页面没有网关"
          description="成员切换需要页面由 dsh-person-web 网关提供。直接打开 DSH 时仍可查看本机、WireGuard 状态并运行构建。"
        />
      ) : null}
      <div className={"dsh-pw-target"}>
        <Space size={8} wrap>
          <Typography.Text strong>当前成员</Typography.Text>
          <Tag color="blue">{targetMember?.name ?? currentTarget}</Tag>
          <span className={"dsh-pw-mono"}>{currentTarget}</span>
          {snapshot?.cluster?.configured === false ? <Tag color="orange">cluster secret 未配置</Tag> : null}
        </Space>
        {currentTarget !== 'local' ? (
          <Button size="small" onClick={() => { api.gateReset() }}>返回本机</Button>
        ) : null}
      </div>
      {(snapshot?.warnings?.length ?? 0) > 0 ? (
        <Alert
          type="warning"
          showIcon
          message="WireGuard 提示"
          description={snapshot?.warnings.join('；')}
        />
      ) : null}
      <Table<Member>
        rowKey="id"
        size="middle"
        pagination={false}
        dataSource={memberRows}
        columns={columns}
        locale={{ emptyText: <Empty description="还没有发现成员" /> }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        成员来自 dsh-wireguard 的 peer 列表；每个 peer 的 /__gate/member 会报告它的网关与 DSH 状态。
        切换后浏览器会带着 dsh_gate_target cookie 重新加载，后续请求由网关转发到该成员。
      </Typography.Text>
    </Space>
  )

  const buildTab = (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Card
        size="small"
        title="从 DSH 源码构建修改版 Web 包"
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => { void loadJobs() }}>刷新任务</Button>}
      >
        <div className={"dsh-pw-form"}>
          <label>
            <Typography.Text type="secondary">源码（留空用固定上游）</Typography.Text>
            <Input
              value={source}
              placeholder={DEFAULT_SOURCE}
              onChange={event => setSource(event.target.value)}
            />
          </label>
          <label>
            <Typography.Text type="secondary">ref</Typography.Text>
            <Input value={ref} placeholder="master" onChange={event => setRef(event.target.value)} />
          </label>
          <label>
            <Typography.Text type="secondary">目标</Typography.Text>
            <Select
              mode="multiple"
              value={targets}
              options={TARGET_OPTIONS}
              onChange={value => setTargets(value)}
              style={{ width: '100%' }}
            />
          </label>
          <Space>
            <Button
              type="primary"
              icon={<RocketOutlined />}
              loading={buildBusy === 'build'}
              onClick={() => { void startBuild(false) }}
            >
              开始构建
            </Button>
            <Button
              loading={buildBusy === 'plan'}
              onClick={() => { void startBuild(true) }}
            >
              只检查覆盖层
            </Button>
          </Space>
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          构建在后台运行：应用 build/recipes.json 的源码覆盖层，运行 pnpm install 与 pnpm run build:web，
          然后按目标打包。覆盖层失配时会先生成工作单，不会带着半套修改继续构建。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="任务">
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            style={{ minWidth: 320 }}
            placeholder="选择已有任务"
            value={job?.id}
            onChange={id => { void chooseJob(id) }}
            options={jobs.map(item => ({
              value: item.id,
              label: `${item.id}  ·  ${statusLabel(item.status)}  ·  ${item.ref}`,
            }))}
          />
          {job !== null ? (
            <Button size="small" icon={<ReloadOutlined />} onClick={() => { void refreshJob(job.id) }}>
              刷新当前任务
            </Button>
          ) : null}
        </Space>

        {job === null ? (
          <Empty description="还没有选择任务" />
        ) : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Descriptions
              size="small"
              column={2}
              items={[
                { key: 'id', label: '任务', children: <span className={"dsh-pw-mono"}>{job.id}</span> },
                { key: 'status', label: '状态', children: <Tag color={statusColor(job.status)}>{statusLabel(job.status)}</Tag> },
                { key: 'phase', label: '阶段', children: job.phase },
                { key: 'ref', label: '源码', children: <span className={"dsh-pw-mono"}>{job.source}@{job.ref}</span> },
                { key: 'targets', label: '目标', children: job.targets.join(', ') },
                { key: 'updated', label: '更新', children: job.updatedAt },
              ]}
            />
            {job.error ? <Alert type="error" showIcon message="构建失败" description={job.error} /> : null}
            {job.status === 'needs-fix' ? (
              <>
                <Alert
                  type="warning"
                  showIcon
                  message="覆盖层需要修复"
                  description={job.workOrderMarkdown ?? '工作单已写入任务目录。把工作单交给 subagent 修好工作树后，点“学习覆盖层”，再继续构建。'}
                />
                <Space wrap>
                  <Button
                    type={job.learnedAt ? 'default' : 'primary'}
                    loading={buildBusy === 'learn'}
                    onClick={() => { void learn() }}
                  >
                    学习覆盖层
                  </Button>
                  <Button
                    loading={buildBusy === 'resume'}
                    onClick={() => { void resume() }}
                  >
                    继续构建
                  </Button>
                </Space>
              </>
            ) : null}
            {job.workOrderPrompt ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                工作单提示词文件：<span className={"dsh-pw-mono"}>{job.workOrderPrompt}</span>
              </Typography.Text>
            ) : null}
            {(job.artifacts?.length ?? 0) > 0 ? (
              <ul className={"dsh-pw-artifacts"}>
                {job.artifacts?.map(artifact => (
                  <li key={artifact.target}>
                    <Tag>{artifact.target}</Tag>
                    <span className={"dsh-pw-mono"}>{artifact.archive}</span>
                    {' '}
                    ({(artifact.bytes / 1024 / 1024).toFixed(1)} MB)
                  </li>
                ))}
              </ul>
            ) : null}
            <pre className={"dsh-pw-log"}>{logLines.length > 0 ? logLines.join('\n') : '暂无日志'}</pre>
          </Space>
        )}
      </Card>
    </Space>
  )

  const pages = [
    {
      key: 'members',
      label: (
        <Space size={6}>
          <CheckCircleOutlined />
          成员
          <Tag>{memberRows.length}</Tag>
        </Space>
      ),
      children: memberTab,
    },
    {
      key: 'build',
      label: (
        <Space size={6}>
          <RocketOutlined />
          构建
          {job !== null ? <Tag color={statusColor(job.status)}>{statusLabel(job.status)}</Tag> : null}
        </Space>
      ),
      children: buildTab,
    },
  ]

  return (
    <ConfigProvider
      locale={ctx.locale.getSnapshot().active?.startsWith('zh') === false ? enUS : zhCN}
      theme={{ algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}
    >
      <style>{styles}</style>
      <div className={"dsh-pw-page"}>
        <div className={"dsh-pw-header"}>
          <div>
            <h1 className={"dsh-pw-title"}>DSH 成员</h1>
            <p className={"dsh-pw-subtitle"}>
              WireGuard 局域网里的 DSH 发现、切换与源码构建。
              {host !== null ? ` 本机 ${host.host.hostname} · ${host.host.platform}-${host.host.arch}` : ''}
            </p>
          </div>
          <div className={"dsh-pw-toolbar"}>
            <Tag icon={gateAvailable ? <CheckCircleOutlined /> : <WarningOutlined />} color={gateAvailable ? 'green' : 'default'}>
              {gateAvailable ? '网关已连接' : '无网关'}
            </Tag>
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void load() }}>刷新</Button>
          </div>
        </div>

        {error !== null ? (
          <Alert
            type="error"
            showIcon
            closable
            message="操作失败"
            description={error}
            onClose={() => setError(null)}
            style={{ marginBottom: 14 }}
          />
        ) : null}

        {loading && snapshot === null ? (
          <div style={{ padding: 60, textAlign: 'center' }}><Spin size="large" /></div>
        ) : (
          <Tabs activeKey={tab} onChange={setTab} items={pages} />
        )}
        {contextHolder}
      </div>
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
    tag.setAttribute('data-dsh-person-web', 'hide-preview-badge')
    tag.textContent = '[class*="previewBadge"]{display:none!important}'
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'person-web: hide preview badge')
  ctx.effect(() => ctx.locale.register(NS, {
    en: { 'panel.label': 'DSH Members' },
    zh: { 'panel.label': 'DSH 成员' },
  }), 'person-web dictionaries')
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
