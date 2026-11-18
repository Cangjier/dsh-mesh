/**
 * Release publishing settings card.
 *
 * The build host uploads every successful build to a fixed `latest` tag on
 * GitHub and Gitee; members then download from there instead of pulling the
 * package through the gateway. The tokens live on the gateway
 * (`~/.dsh/mesh/release.json`, 0600) and are never returned to the browser —
 * the panel only learns whether one is stored.
 *
 * @module dsh-mesh/client/release
 */

import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Divider, Input, InputNumber, Space, Switch, Tag, Typography, message } from 'antd'
import { CloudUploadOutlined, SaveOutlined } from '@ant-design/icons'
import { api, ApiError, type ReleaseSettings } from './api'

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（HTTP ${String(error.status)}）`
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)} ${units[unit]}`
}

/** One masked token field. */
function TokenInput({ value, onChange, placeholder }: { value: string, onChange: (value: string) => void, placeholder: string }) {
  return (
    <Input.Password
      size="small"
      style={{ width: 200 }}
      value={value}
      placeholder={placeholder}
      onChange={event => onChange(event.target.value)}
      autoComplete="new-password"
    />
  )
}

export function ReleaseCard({ active }: { active: boolean }) {
  const [messageApi, contextHolder] = message.useMessage()
  const [config, setConfig] = useState<ReleaseSettings | null>(null)
  const [manifestUrls, setManifestUrls] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [githubToken, setGithubToken] = useState('')
  const [giteeToken, setGiteeToken] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.releaseSettings()
      setConfig(result.config)
      setManifestUrls(result.manifestUrls)
      setWarnings([])
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const update = useCallback((patch: Partial<ReleaseSettings>) => {
    setConfig(previous => (previous === null ? previous : { ...previous, ...patch }))
  }, [])

  const updateRepo = useCallback((repo: 'github' | 'gitee', patch: object) => {
    setConfig(previous => (previous === null ? previous : { ...previous, [repo]: { ...previous[repo], ...patch } }))
  }, [])

  const save = useCallback(async () => {
    if (config === null) return
    setSaving(true)
    setError('')
    setWarnings([])
    try {
      const result = await api.saveReleaseSettings({
        enabled: config.enabled,
        tag: config.tag,
        partBytes: config.partBytes,
        github: {
          owner: config.github.owner,
          repo: config.github.repo,
          ...(githubToken.trim() === '' ? {} : { token: githubToken.trim() }),
        },
        gitee: {
          owner: config.gitee.owner,
          repo: config.gitee.repo,
          branch: config.gitee.branch,
          ...(giteeToken.trim() === '' ? {} : { token: giteeToken.trim() }),
        },
      })
      setConfig(result.config)
      setManifestUrls(result.manifestUrls)
      setWarnings(result.warnings ?? [])
      setGithubToken('')
      setGiteeToken('')
      messageApi.success(result.configured ? 'Release 设置已保存；下次编译完成后自动上传' : '已保存；填好 token 后编译才会发布')
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSaving(false)
    }
  }, [config, giteeToken, githubToken, messageApi])

  return (
    <Card
      size="small"
      title={<Space size={6}><CloudUploadOutlined />Release 发布</Space>}
      extra={(
        <Space size={8}>
          {config?.github.enabled === true ? <Tag color="green">GitHub 已配置</Tag> : <Tag>GitHub 未启用</Tag>}
          {config?.gitee.enabled === true ? <Tag color="green">Gitee 已配置</Tag> : <Tag>Gitee 未启用</Tag>}
          <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving || loading} onClick={() => { void save() }}>
            保存
          </Button>
        </Space>
      )}
    >
      {contextHolder}
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          只填 token 即可：owner 由 token 自动识别，仓库默认 <span className="dsh-pw-mono">dsh-web-release</span>（公开仓库，不存在会自动创建），Gitee 分支默认 <span className="dsh-pw-mono">master</span>。
          编译完成后把最新包上传到固定的 <span className="dsh-pw-mono">{config?.tag ?? 'latest'}</span> Release（旧资产自动删除）；成员升级时优先从 Release 下载：GitHub 走外网代理，Gitee 直连。
          Gitee 单附件约 100MB，包会按分片上传再合并；GitHub 保留整包。
        </Typography.Text>
        {error !== '' ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
        {warnings.length > 0 ? <Alert type="warning" showIcon message="自动识别账号未完成" description={warnings.join('；')} closable onClose={() => setWarnings([])} /> : null}
        {config === null ? (
          <Typography.Text type="secondary">{loading ? '读取设置…' : '没有可读取的设置'}</Typography.Text>
        ) : (
          <>
            <Space size={10} wrap>
              <Space size={6}>
                <Typography.Text type="secondary">发布 / Release 下载</Typography.Text>
                <Switch size="small" checked={config.enabled} onChange={value => update({ enabled: value })} />
              </Space>
              <Space size={6}>
                <Typography.Text type="secondary">Tag</Typography.Text>
                <Input size="small" style={{ width: 100 }} value={config.tag} onChange={event => update({ tag: event.target.value })} />
              </Space>
              <Space size={6}>
                <Typography.Text type="secondary">Gitee 分片</Typography.Text>
                <InputNumber
                  size="small"
                  style={{ width: 110 }}
                  min={1}
                  max={95}
                  value={Math.round(config.partBytes / 1024 / 1024)}
                  addonAfter="MiB"
                  onChange={value => update({ partBytes: Math.max(1, Math.min(95, Number(value) || 85)) * 1024 * 1024 })}
                />
              </Space>
            </Space>
            <Divider style={{ margin: '2px 0' }} />
            <Space size={10} wrap>
              <Typography.Text strong style={{ width: 60 }}>GitHub</Typography.Text>
              <Input size="small" style={{ width: 150 }} prefix="owner" placeholder="自动识别" value={config.github.owner} onChange={event => updateRepo('github', { owner: event.target.value })} />
              <Input size="small" style={{ width: 150 }} prefix="repo" placeholder="dsh-web-release" value={config.github.repo} onChange={event => updateRepo('github', { repo: event.target.value })} />
              <TokenInput value={githubToken} onChange={setGithubToken} placeholder={config.github.hasToken ? '已保存，留空不改' : 'personal access token'} />
            </Space>
            <Space size={10} wrap>
              <Typography.Text strong style={{ width: 60 }}>Gitee</Typography.Text>
              <Input size="small" style={{ width: 150 }} prefix="owner" placeholder="自动识别" value={config.gitee.owner} onChange={event => updateRepo('gitee', { owner: event.target.value })} />
              <Input size="small" style={{ width: 150 }} prefix="repo" placeholder="dsh-web-release" value={config.gitee.repo} onChange={event => updateRepo('gitee', { repo: event.target.value })} />
              <Input size="small" style={{ width: 110 }} prefix="branch" placeholder="master" value={config.gitee.branch} onChange={event => updateRepo('gitee', { branch: event.target.value })} />
              <TokenInput value={giteeToken} onChange={setGiteeToken} placeholder={config.gitee.hasToken ? '已保存，留空不改' : 'private token'} />
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              配置文件：<span className="dsh-pw-mono">{config.file}</span>
              {config.fileError === null ? '' : `（读取失败：${config.fileError}）`}
            </Typography.Text>
            {manifestUrls.length === 0 ? (
              <Alert type="warning" showIcon message="还没有可用的 Release 地址：填一个 token 并保存，owner 会自动识别" />
            ) : (
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>成员读取的最新清单：</Typography.Text>
                {manifestUrls.map(url => (
                  <Typography.Text key={url} className="dsh-pw-mono" style={{ fontSize: 12 }} copyable={{ text: url }}>{url}</Typography.Text>
                ))}
              </Space>
            )}
            {config.gitee.enabled ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                注意：Gitee 仓库需公开（私有 Release 需要 token，成员无法直接下载），单文件上限约 100MB、仓库附件总量约 1GB；仓库不存在时会用这个 token 自动创建（需要 projects 权限），发布时先清旧分片再传新分片。当前分片大小 {formatBytes(config.partBytes)}。
              </Typography.Text>
            ) : null}
          </>
        )}
      </Space>
    </Card>
  )
}
