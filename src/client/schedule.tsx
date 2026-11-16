/**
 * Schedule controls shared by the build card and the per-member auto-upgrade
 * dialog.
 *
 * The server owns the timer; this component only edits the settings and shows
 * the next/last run. A missing schedule API (an older member running an older
 * plugin) is shown as unavailable instead of breaking the page.
 */

import { useCallback, useEffect, useState } from 'react'
import { Alert, Card, Modal, Select, Space, Switch, Tag, Typography, message } from 'antd'
import { ClockCircleOutlined } from '@ant-design/icons'
import { api, ApiError, type Member, type ScheduleEntry, type ScheduleState } from './api'

const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour).padStart(2, '0'),
  label: String(hour).padStart(2, '0'),
}))
const MINUTES = Array.from({ length: 60 }, (_, minute) => ({
  value: String(minute).padStart(2, '0'),
  label: String(minute).padStart(2, '0'),
}))

function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}（HTTP ${String(error.status)}）`
  return error instanceof Error ? error.message : String(error)
}

/** Short Chinese description of the last timed run. */
function lastRunText(entry: ScheduleEntry): string {
  const last = entry.last
  if (last === null || last.at === undefined) return '还没有运行过'
  const when = new Date(last.at).toLocaleString()
  if (last.status === 'skipped') return `${when} · 跳过：${last.reason ?? '没有变化'}`
  if (last.status === 'failed') return `${when} · 失败：${last.reason ?? '未知原因'}`
  if (last.status === 'done') {
    const count = last.upgraded?.length ?? 0
    return `${when} · 完成${count > 0 ? `（${String(count)} 个成员）` : ''}`
  }
  if (last.status === 'started') return `${when} · 已开始${last.jobId === undefined ? '' : ` · ${last.jobId.slice(0, 20)}`}`
  return `${when} · ${last.status ?? '未知'}`
}

/**
 * Load and save one schedule scope: the build clock, or one member's upgrade.
 * @param {'build'|'upgrade'} kind schedule kind.
 * @param {string|undefined} memberId member id for an upgrade scope.
 * @param {boolean} active whether the scope is visible.
 */
function useSchedule(kind: 'build' | 'upgrade', memberId: string | undefined, active: boolean) {
  const [messageApi, contextHolder] = message.useMessage()
  const [schedule, setSchedule] = useState<ScheduleState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await api.schedule(memberId)
      setSchedule(result.schedule)
      setError('')
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [memberId])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const update = useCallback(async (patch: { enabled?: boolean, time?: string }) => {
    setSaving(true)
    try {
      const result = kind === 'build'
        ? await api.setSchedule({ build: patch })
        : await api.setSchedule({ member: memberId, upgrade: patch })
      setSchedule(result.schedule)
      setError('')
    } catch (failure) {
      messageApi.error(errorText(failure))
    } finally {
      setSaving(false)
    }
  }, [kind, memberId, messageApi])

  return {
    contextHolder,
    error,
    saving,
    entry: schedule === null ? null : (kind === 'build' ? schedule.build : schedule.upgrade) ?? null,
    update,
  }
}

/**
 * The switch, daily clock, and next/last line.
 */
function ScheduleControls({ entry, saving, disabled, update, fallbackTime }: {
  entry: ScheduleEntry | null
  saving: boolean
  disabled: boolean
  update: (patch: { enabled?: boolean, time?: string }) => void
  fallbackTime: string
}) {
  const time = entry?.time ?? fallbackTime
  const [hour, minute] = time.split(':')
  const locked = disabled || saving
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={10} wrap>
        <Switch
          size="small"
          checked={entry?.enabled ?? false}
          loading={saving}
          disabled={disabled}
          checkedChildren="开"
          unCheckedChildren="关"
          onChange={enabled => { update({ enabled }) }}
        />
        <Typography.Text type="secondary">每天</Typography.Text>
        <Select
          size="small"
          style={{ width: 72 }}
          value={hour}
          disabled={locked || entry?.enabled === false}
          options={HOURS}
          onChange={value => { update({ time: `${value}:${minute}` }) }}
        />
        <Typography.Text type="secondary">:</Typography.Text>
        <Select
          size="small"
          style={{ width: 72 }}
          value={minute}
          disabled={locked || entry?.enabled === false}
          options={MINUTES}
          onChange={value => { update({ time: `${hour}:${value}` }) }}
        />
        {entry?.running === true ? <Tag color="processing">运行中</Tag> : null}
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        下次：{entry?.next === null || entry?.next === undefined ? '未启用' : new Date(entry.next).toLocaleString()}
        {' · '}
        {entry === null ? '读取中…' : lastRunText(entry)}
      </Typography.Text>
    </Space>
  )
}

/**
 * The build card in the package panel.
 * @param {{active: boolean}} props card input.
 */
export function ScheduleCard({ active }: { active: boolean }) {
  const { contextHolder, error, saving, entry, update } = useSchedule('build', undefined, active)
  return (
    <Card
      size="small"
      title={<Space size={6}><ClockCircleOutlined />自动编译</Space>}
    >
      {contextHolder}
      {error !== '' ? <Alert type="warning" showIcon message={`定时设置不可用：${error}`} style={{ marginBottom: 10 }} /> : null}
      <ScheduleControls entry={entry} saving={saving} disabled={entry === null} update={update} fallbackTime="04:00" />
    </Card>
  )
}

/**
 * Per-member auto-upgrade dialog, opened from the member's 更多 menu.
 * @param {{member: Member|null, onClose: () => void}} props dialog input.
 */
export function AutoUpgradeModal({ member, onClose }: { member: Member | null, onClose: () => void }) {
  const active = member !== null
  const { contextHolder, error, saving, entry, update } = useSchedule('upgrade', member?.id, active)
  return (
    <Modal
      open={active}
      title={member === null ? '自动升级' : `自动升级 · ${member.name}`}
      width={420}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      {contextHolder}
      {error !== '' ? <Alert type="warning" showIcon message={`定时设置不可用：${error}`} style={{ marginBottom: 10 }} /> : null}
      <ScheduleControls entry={entry} saving={saving} disabled={entry === null} update={update} fallbackTime="06:00" />
    </Modal>
  )
}
