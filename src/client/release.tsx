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
          ...(giteeToken.trim() === '' ? {} : { token: giteeToken.trim() }),
        },
      })
      setConfig(result.config)
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
              <TokenInput value={githubToken} onChange={setGithubToken} placeholder={config.github.hasToken ? '已保存，留空不改' : 'personal access token'} />
            </Space>
            <Space size={10} wrap>
              <Typography.Text strong style={{ width: 60 }}>Gitee</Typography.Text>
              <TokenInput value={giteeToken} onChange={setGiteeToken} placeholder={config.gitee.hasToken ? '已保存，留空不改' : 'private token'} />
            </Space>
          </>
        )}
      </Space>
    </Card>
  )
}
