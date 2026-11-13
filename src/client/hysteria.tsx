import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { LinkOutlined } from '@ant-design/icons'
import {
  api,
  type HysteriaAssets,
  type HysteriaJob,
  type HysteriaLink,
  type Member,
} from './api'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stepStatus(status: string): 'wait' | 'process' | 'finish' | 'error' {
  if (status === 'running') return 'process'
  if (status === 'succeeded') return 'finish'
  if (status === 'failed') return 'error'
  return 'wait'
}

function jobColor(status: string): string {
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'error'
  return 'processing'
}

function percentOf(job: HysteriaJob): number {
  if (job.status === 'succeeded') return 100
  return Math.max(0, Math.min(99, Math.round(job.progress?.percent ?? 0)))
}

function formatBytes(value: number | undefined): string {
  const bytes = Number(value ?? 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function HysteriaProgress({ job, lines }: { job: HysteriaJob; lines: string[] }) {
  const steps = job.steps ?? []
  const active = steps.find(step => step.status === 'running')
  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Tag color={jobColor(job.status)}>
          {job.status === 'running' ? `配置中 ${String(percentOf(job))}%` : job.status === 'succeeded' ? '已完成' : '失败'}
        </Tag>
        <Typography.Text type="secondary" className="dsh-pw-mono">
          {job.server.name} → {job.client.name} · udp/{String(job.port)} · {job.mode.toUpperCase()}
        </Typography.Text>
      </Space>
      {job.error !== null && job.error !== undefined && job.error !== '' ? (
        <Alert type="error" showIcon message={job.error} />
      ) : null}
      {job.warning !== null && job.warning !== undefined && job.warning !== '' ? (
        <Alert type="warning" showIcon message={job.warning} />
      ) : null}
      <Progress
        percent={percentOf(job)}
        status={job.status === 'failed' ? 'exception' : job.status === 'running' ? 'active' : 'success'}
        format={percent => `${String(percent)}%`}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {job.progress?.label ?? '准备中'}
        {job.progress?.totalBytes
          ? ` · ${formatBytes(job.progress.bytes)} / ${formatBytes(job.progress.totalBytes)}`
          : ''}
        {job.progress?.speed ? ` · ${formatBytes(job.progress.speed)}/s` : ''}
        {active ? ` · ${active.label}` : ''}
      </Typography.Text>
      <Steps
        size="small"
        direction="vertical"
        items={steps.map(step => ({
          key: step.key,
          title: step.label,
          status: stepStatus(step.status),
          description: step.detail !== '' ? step.detail : undefined,
        }))}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>配置日志</Typography.Text>
      <pre className="dsh-pw-deploy-log">{lines.length > 0 ? lines.slice(-200).join('\n') : '等待日志…'}</pre>
    </Space>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Space direction="vertical" size={4}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text>
      {children}
    </Space>
  )
}

/** One device in the 组网 table; the modal resolves it to a DSH member by VPN address. */
export interface DirectLinkPeer {
  name: string
  ip: string
  platform?: 'linux' | 'windows' | null
}

/**
 * Direct links (hysteria2) for a single mesh device. The old standalone tab
 * listed every link; this modal scopes the same data to one device and lets the
 * operator add another link without leaving the mesh table.
 */
export function DirectLinksModal({
  open,
  peer,
  members,
  gateAvailable,
  onClose,
}: {
  open: boolean
  peer: DirectLinkPeer | null
  members: Member[]
  gateAvailable: boolean
  onClose: () => void
}) {
  const [messageApi, contextHolder] = message.useMessage()
  const [assets, setAssets] = useState<HysteriaAssets | null>(null)
  const [links, setLinks] = useState<HysteriaLink[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [targetId, setTargetId] = useState<string | undefined>(undefined)
  const [role, setRole] = useState<'server' | 'client'>('client')
  const [port, setPort] = useState<number>(8443)
  const [mode, setMode] = useState<'tun' | 'socks'>('tun')
  const [bandwidth, setBandwidth] = useState<number>(30)
  const [serverHost, setServerHost] = useState('')
  const [starting, setStarting] = useState(false)
  const [removing, setRemoving] = useState('')
  const [progressJob, setProgressJob] = useState<HysteriaJob | null>(null)
  const [progressLines, setProgressLines] = useState<string[]>([])

  const member = useMemo(() => {
    if (peer === null) return undefined
    return members.find(candidate => candidate.ip === peer.ip)
      ?? members.find(candidate => candidate.name === peer.name)
  }, [members, peer])

  const targets = useMemo(
    () => members.filter(candidate => candidate.id !== 'local' && candidate.id !== member?.id),
    [members, member],
  )

  const load = useCallback(async (silent = false) => {
    if (!gateAvailable) return
    if (!silent) setLoading(true)
    try {
      const [assetResult, linkResult] = await Promise.all([
        api.hysteriaAssets(),
        api.hysteriaLinks(),
      ])
      setAssets(assetResult)
      setLinks(linkResult.links)
      setError('')
    } catch (failure) {
      if (!silent) setError(errorText(failure))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [gateAvailable])

  const peerIp = peer?.ip ?? ''
  useEffect(() => {
    if (!open) return
    setTargetId(undefined)
    setRole('client')
    setPort(8443)
    setMode('tun')
    setBandwidth(30)
    setServerHost('')
    setError('')
    setProgressJob(null)
    setProgressLines([])
  }, [open, peerIp])

  useEffect(() => {
    if (!open || !gateAvailable) return
    void load()
    const timer = window.setInterval(() => { void load(true) }, 4000)
    return () => { window.clearInterval(timer) }
  }, [open, gateAvailable, load, peerIp])

  const progressId = progressJob?.id ?? ''
  useEffect(() => {
    if (!open || progressId === '') return
    let alive = true
    const tick = async () => {
      try {
        const result = await api.hysteriaJob(progressId, 300)
        if (!alive) return
        setProgressJob(result.job)
        setProgressLines(result.lines)
        if (result.job.status === 'succeeded') void load(true)
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
  }, [open, progressId, load])

  const related = useMemo(
    () => (member === undefined
      ? []
      : links.filter(link => link.server.id === member.id || link.client.id === member.id)),
    [links, member],
  )

  const start = useCallback(async () => {
    if (member === undefined) {
      void messageApi.warning('该设备还没有 DSH 成员信息，无法配置直连')
      return
    }
    if (targetId === undefined) {
      void messageApi.warning('请选择对端设备')
      return
    }
    const server = role === 'server' ? member.id : targetId
    const client = role === 'server' ? targetId : member.id
    setStarting(true)
    try {
      const result = await api.hysteriaConfigure({
        server,
        client,
        port: typeof port === 'number' && Number.isFinite(port) ? port : 8443,
        mode,
        bandwidth: typeof bandwidth === 'number' && Number.isFinite(bandwidth) ? bandwidth : 30,
        ...(serverHost.trim() === '' ? {} : { serverHost: serverHost.trim() }),
      })
      setProgressJob(result.job)
      setProgressLines([])
      void messageApi.info(`直连配置已开始：${result.job.id}`)
      void load(true)
    } catch (failure) {
      setError(errorText(failure))
      void messageApi.error(errorText(failure))
    } finally {
      setStarting(false)
    }
  }, [member, targetId, role, port, mode, bandwidth, serverHost, messageApi, load])

  const remove = useCallback(async (link: HysteriaLink) => {
    const key = `${link.server.ip}/${link.client.ip}`
    setRemoving(key)
    try {
      const result = await api.hysteriaRemove({ server: link.server.ip, client: link.client.ip })
      const warnings = result.errors ?? []
      if (warnings.length > 0) {
        void messageApi.warning(`直连已删除，但本机清理有提示：${warnings.join('；')}`)
      } else {
        void messageApi.success('直连已删除')
      }
      void load(true)
    } catch (failure) {
      void messageApi.error(errorText(failure))
    } finally {
      setRemoving('')
    }
  }, [messageApi, load])

  const assetReady = assets?.ok === true && (assets.assets?.length ?? 0) >= 2
  const canStart = gateAvailable && member !== undefined && targetId !== undefined && assetReady

  const columns: ColumnsType<HysteriaLink> = [
    {
      title: '直连设备',
      key: 'peer',
      render: (_value, link) => {
        const other = member !== undefined && link.server.id === member.id ? link.client : link.server
        return (
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{other.name}</Typography.Text>
            <Typography.Text type="secondary" className="dsh-pw-mono" style={{ fontSize: 11 }}>{other.ip}</Typography.Text>
          </Space>
        )
      },
    },
    {
      title: '本机角色',
      key: 'role',
      width: 110,
      render: (_value, link) => (
        <Tag color={member !== undefined && link.server.id === member.id ? 'blue' : 'green'}>
          {member !== undefined && link.server.id === member.id ? '服务端' : '客户端'}
        </Tag>
      ),
    },
    {
      title: '服务端入口',
      key: 'endpoint',
      width: 200,
      render: (_value, link) => (
        <Typography.Text className="dsh-pw-mono">{link.publicHost}:{String(link.port)}/udp</Typography.Text>
      ),
    },
    {
      title: '模式 / 带宽',
      key: 'mode',
      width: 150,
      render: (_value, link) => `${link.mode.toUpperCase()} · ${String(link.bandwidth)} Mbps`,
    },
    {
      title: '更新时间',
      key: 'updatedAt',
      width: 170,
      render: (_value, link) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {link.updatedAt ? new Date(link.updatedAt).toLocaleString() : '—'}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_value, link) => (
        <Popconfirm
          title="删除这条直连？"
          description="会停止两端 hysteria2 服务、移除隧道路由并删除这条记录。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => { void remove(link) }}
        >
          <Button size="small" type="text" danger loading={removing === `${link.server.ip}/${link.client.ip}`}>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <Modal
      open={open}
      title={`直连 · ${peer?.name ?? ''}`}
      width={860}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
      destroyOnHidden
    >
      {contextHolder}
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        {!gateAvailable ? (
          <Alert type="info" showIcon message="直连配置需要通过网关访问（当前是直连 DSH 的本地页面）" />
        ) : null}
        {gateAvailable && member === undefined ? (
          <Alert
            type="warning"
            showIcon
            message="该设备不在成员列表中"
            description="这台设备只加入了 WireGuard，还没有部署 DSH 成员，暂时无法为它配置直连。"
          />
        ) : null}
        {assetReady ? null : (
          <Alert
            type="warning"
            showIcon
            message="hysteria2 静态资源不完整"
            description={assets?.error ?? '需要 Linux 和 Windows 两份二进制，放在网关的 gate/assets/hysteria2 下。'}
          />
        )}
        {error !== '' ? <Alert type="error" showIcon message={error} onClose={() => setError('')} /> : null}

        <Card
          size="small"
          title="已建立的直连"
          extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>共 {String(related.length)} 条</Typography.Text>}
        >
          <Table<HysteriaLink>
            rowKey={link => `${link.server.ip}-${link.client.ip}`}
            size="small"
            loading={loading}
            dataSource={related}
            columns={columns}
            pagination={false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该设备还没有直连" /> }}
          />
        </Card>

        <Card size="small" title="新增直连">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space size={12} wrap>
              <Field label="对端设备">
                <Select
                  style={{ width: 230 }}
                  value={targetId}
                  placeholder="选择对端设备"
                  onChange={value => setTargetId(value)}
                  options={targets.map(candidate => ({
                    value: candidate.id,
                    label: `${candidate.name} · ${candidate.ip}`,
                    disabled: !candidate.online,
                  }))}
                />
              </Field>
              <Field label="本机角色">
                <Radio.Group value={role} onChange={event => setRole(event.target.value as 'server' | 'client')}>
                  <Radio.Button value="client">本机为客户端</Radio.Button>
                  <Radio.Button value="server">本机为服务端</Radio.Button>
                </Radio.Group>
              </Field>
              <Field label="UDP 端口">
                <InputNumber min={1} max={65535} value={port} onChange={value => setPort(Number(value ?? 8443))} style={{ width: 110 }} />
              </Field>
              <Field label="客户端带宽上限 (Mbps)">
                <InputNumber min={1} max={200} value={bandwidth} onChange={value => setBandwidth(Number(value ?? 30))} style={{ width: 110 }} />
              </Field>
              <Field label="客户端接入方式">
                <Radio.Group value={mode} onChange={event => setMode(event.target.value as 'tun' | 'socks')}>
                  <Radio.Button value="tun">TUN 透明</Radio.Button>
                  <Radio.Button value="socks">SOCKS5</Radio.Button>
                </Radio.Group>
              </Field>
            </Space>
            <Space size={12} wrap align="end">
              <Field label="服务端公网地址（留空自动探测）">
                <Input style={{ width: 230 }} value={serverHost} placeholder="例如 43.172.94.59" onChange={event => setServerHost(event.target.value)} />
              </Field>
              <Button
                type="primary"
                icon={<LinkOutlined />}
                loading={starting}
                disabled={!canStart}
                onClick={() => { void start() }}
              >
                建立直连
              </Button>
            </Space>
            <Alert
              type="info"
              showIcon
              message={`服务端安全组/防火墙需要放行 UDP ${String(port)}；TUN 会给客户端添加对端 /32 路由，失败会自动回退 SOCKS5。`}
            />
          </Space>
        </Card>
      </Space>

      <Modal
        open={progressJob !== null}
        title={`直连进度 · ${progressJob?.server.name ?? ''} → ${progressJob?.client.name ?? ''}`}
        onCancel={() => setProgressJob(null)}
        footer={<Button onClick={() => setProgressJob(null)}>关闭</Button>}
        width={720}
        destroyOnHidden
      >
        {progressJob !== null ? <HysteriaProgress job={progressJob} lines={progressLines} /> : null}
      </Modal>
    </Modal>
  )
}
