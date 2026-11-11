import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Empty,
  Grid,
  Modal,
  Select,
  Space,
  Spin,
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
  ReloadOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import styles from './styles.css'
import { api, ApiError, type Member, type PackageInfo, type Snapshot, type SystemInfo } from './api'
import { WireGuardPanel } from './wireguard'
import { EN as WIREGUARD_EN, dictionary as wireguardDictionary } from './wireguard/i18n'

const NS = 'dsh-person-web'
const PANEL_ID = 'person-web'

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
  return system?.platform === 'win32' ? `${base}\\.dsh\\dsh-person-web` : `${base}/.dsh/dsh-person-web`
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
  const [panelTab, setPanelTab] = useState<'members' | 'network'>('members')
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

  const memberRows = useMemo(() => {
    if (snapshot === null) return []
    const local = snapshot.local
    const peers = snapshot.members.filter(member => member.id !== 'local')
    return local ? [local, ...peers] : peers
  }, [snapshot])

  const currentTarget = snapshot?.target ?? 'local'

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
      messageApi.success(`部署任务已启动：${result.job.id}；完成后点右上角刷新`)
      setDeployTarget(null)
      setError(null)
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy('')
    }
  }, [deployTarget, selectedPackage, messageApi])

  const columns: ColumnsType<Member> = useMemo(() => {
    const actionColumn: ColumnsType<Member>[number] = {
      title: '操作',
      key: 'action',
      width: 150,
      align: 'right',
      render: (_value, member) => {
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
        width: 260,
        render: (_value, member) => (
          <Space direction="vertical" size={0}>
            <Space size={6} wrap>
              <Typography.Text strong>{member.name}</Typography.Text>
              {member.kind === 'self' ? <Tag>本机</Tag> : null}
              {screens.sm !== true ? (
                <Tag color={member.online ? 'green' : 'default'}>{member.online ? '在线' : '离线'}</Tag>
              ) : null}
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {member.gate?.hostname !== undefined ? String(member.gate.hostname) : member.id}
            </Typography.Text>
          </Space>
        ),
      },
      {
        title: '地址',
        key: 'address',
        width: 150,
        responsive: ['lg'],
        render: (_value, member) => (
          <Typography.Text className="dsh-pw-mono" style={{ fontSize: 12 }}>
            {member.ip || member.id}
          </Typography.Text>
        ),
      },
      {
        title: '状态',
        key: 'status',
        width: 190,
        responsive: ['sm'],
        render: (_value, member) => (
          <Space size={6} wrap>
            <Tag color={member.online ? 'green' : 'default'}>{member.online ? '在线' : '离线'}</Tag>
            {member.dsh
              ? <Tag color="cyan">DSH :{String(member.port ?? '?')}</Tag>
              : <Tag>未部署</Tag>}
            {member.latencyMs > 0 ? <Typography.Text type="secondary" style={{ fontSize: 11 }}>{String(member.latencyMs)} ms</Typography.Text> : null}
          </Space>
        ),
      },
      {
        title: '系统',
        key: 'system',
        width: 260,
        responsive: ['lg'],
        render: (_value, member) => (
          <Tooltip title={<pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>{systemDetails(member)}</pre>}>
            <Typography.Text style={{ fontSize: 12 }}>{systemText(member)}</Typography.Text>
          </Tooltip>
        ),
      },
    ]
    return [...base, actionColumn]
  }, [busy, currentTarget, gateAvailable, openDeploy, screens, switchMember])

  if (loading && snapshot === null) {
    return (
      <ConfigProvider
        locale={ctx.locale.getSnapshot().active?.startsWith('zh') === false ? enUS : zhCN}
        theme={{ algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}
      >
        <style>{styles}</style>
        <div className="dsh-pw-boot">
          <Typography.Title level={3} style={{ margin: 0 }}>DSH 成员</Typography.Title>
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
            <h1 className="dsh-pw-title">DSH 成员</h1>
            <p className="dsh-pw-subtitle">WireGuard 局域网里的 DSH 发现、切换与部署。</p>
          </div>
          <div className="dsh-pw-toolbar">
            <Tag icon={gateAvailable ? <ApartmentOutlined /> : <WarningOutlined />} color={gateAvailable ? 'green' : 'default'}>
              {gateAvailable ? '网关已连接' : '本机直连'}
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

        <Tabs
          className="dsh-pw-tabs"
          activeKey={panelTab}
          onChange={key => setPanelTab(key as 'members' | 'network')}
          items={[
            {
              key: 'members',
              label: '成员',
              children: (
        <Card size="small">
              <Table<Member>
                rowKey="id"
                size="middle"
                dataSource={memberRows}
                columns={columns}
                scroll={{ x: screens.lg === true ? 1000 : undefined, y: 'max(240px, calc(100vh - 320px))' }}
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
              ),
            },
            {
              key: 'network',
              label: '组网',
              children: <WireGuardPanel ctx={ctx} embedded />,
            },
          ]}
        />
        {contextHolder}
      </div>

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
