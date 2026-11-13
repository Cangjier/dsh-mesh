import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  ConfigProvider,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  theme as antdTheme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  GlobalOutlined,
  KeyOutlined,
  LaptopOutlined,
  LinkOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import styles from './styles.css';
import {
  api,
  ApiError,
  type ClientState,
  type Peer,
  type ServerState,
  type Settings,
  type Snapshot,
} from './api';
import { buildLinuxClientCommand, buildLinuxClientSimpleCommand, buildWindowsClientCommand, LINUX_CLIENT_RESTART_COMMAND } from './deploy';
import { dictionary, EN, interpolate, type MessageKey } from './i18n';
import type { Member } from '../api';
import { DirectLinksModal, type DirectLinkPeer } from '../hysteria';

const NS = 'dsh-wireguard';
const PANEL_ID = 'wireguard';
const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

/**
 * Copy text with the async Clipboard API, falling back to a hidden textarea on
 * plain-HTTP origins where navigator.clipboard is unavailable.
 * @param {string} text text to copy.
 * @returns {Promise<boolean>} whether the copy succeeded.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

type T = (key: string, params?: Record<string, string | number>) => string;
type TabKey = 'service' | 'client';
type EgressOutcome = {
  applied: boolean;
  egress: boolean;
  state: Snapshot;
  manual?: { enable: string; disable: string };
  reason?: string;
};

function useT(ctx: any, provided?: (key: string) => string): T {
  const [, force] = useState(0);
  useEffect(() => ctx.locale.subscribe(() => force((value) => value + 1)), [ctx]);
  return useCallback((key: string, params?: Record<string, string | number>) => {
    let text: string | undefined;
    try {
      text = provided ? provided(key) : ctx.locale.bind(NS)(key);
    } catch {
      text = undefined;
    }
    if (!text || text === key) {
      const active = ctx.locale.getSnapshot().active || '';
      text = dictionary(active)[key as MessageKey] ?? EN[key as MessageKey] ?? key;
    }
    return interpolate(text, params);
  }, [ctx, provided]);
}

function useThemeMode(ctx: any): 'light' | 'dark' {
  const [snapshot, setSnapshot] = useState<any>(() => ctx.theme.getTheme());
  useEffect(() => ctx.on('theme/change', (next: any) => setSnapshot(next)), [ctx]);
  return snapshot?.active?.colorScheme === 'dark' ? 'dark' : 'light';
}

function useController(ctx: any) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [retries, setRetries] = useState(0);
  const [busy, setBusy] = useState('');
  const sequence = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async (force = false) => {
    const current = ++sequence.current;
    if (!force) setRefreshing(true);
    try {
      const next = await (force ? api.refresh() : api.state());
      if (!alive.current || current !== sequence.current) return;
      setState(next);
      setError(null);
      setRetries(0);
    } catch (failure) {
      if (!alive.current || current !== sequence.current) return;
      setError(failure instanceof ApiError ? failure : new ApiError({ code: 'unknown', message: String(failure) }, 0));
      // The Host is restarting; try again shortly instead of waiting for the user.
      setRetries(failure instanceof ApiError && failure.code === 'backend_unavailable' ? count => count + 1 : 0);
      if (failure instanceof ApiError && failure.state) setState(failure.state);
    } finally {
      if (alive.current) {
        setLoading(false);
        if (!force) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    // Load once on mount. Live counters are only updated when the user asks
    // for a refresh, so opening the panel does not poll the Host forever.
    void refresh(false);
  }, [refresh]);

  // While the Host is starting up, retry on our own for about two minutes.
  useEffect(() => {
    if (retries === 0 || retries > 30) return;
    const timer = window.setTimeout(() => { void refresh(false); }, 4000);
    return () => { window.clearTimeout(timer); };
  }, [retries, refresh]);

  const action = useCallback(async (key: string, operation: () => Promise<Snapshot>) => {
    setBusy(key);
    try {
      const next = await operation();
      if (alive.current) {
        setState(next);
        setError(null);
        setRetries(0);
      }
      return next;
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof ApiError ? failure : new ApiError({ code: 'unknown', message: String(failure) }, 0));
        if (failure instanceof ApiError && failure.state) setState(failure.state);
      }
      return undefined;
    } finally {
      if (alive.current) setBusy('');
    }
  }, []);

  const configureSsh = useCallback(async (publicKey: string, user: string, platform: 'linux' | 'windows') => {
    setBusy('ssh');
    try {
      const result = await api.configureSsh(publicKey, user, platform);
      if (alive.current) {
        setState(result.state);
        setError(null);
        setRetries(0);
      }
      return result.commands;
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof ApiError ? failure : new ApiError({ code: 'unknown', message: String(failure) }, 0));
        if (failure instanceof ApiError && failure.state) setState(failure.state);
      }
      return undefined;
    } finally {
      if (alive.current) setBusy('');
    }
  }, []);

  const setPeerEgress = useCallback(async (publicKey: string, enabled: boolean) => {
    setBusy('egress');
    try {
      const result = await api.setPeerEgress(publicKey, enabled);
      if (alive.current) {
        setState(result.state);
        setError(null);
        setRetries(0);
      }
      return result;
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof ApiError ? failure : new ApiError({ code: 'unknown', message: String(failure) }, 0));
        if (failure instanceof ApiError && failure.state) setState(failure.state);
      }
      return undefined;
    } finally {
      if (alive.current) setBusy('');
    }
  }, []);

  return useMemo(() => ({
    state,
    loading,
    refreshing,
    error,
    busy,
    refresh,
    recheck: () => refresh(true),
    clearError: () => setError(null),
    install: () => action('install', api.install),
    startServer: (settings: Settings) => action('start', () => api.startServer(settings)),
    stopServer: () => action('stop', api.stopServer),
    removePeer: (publicKey: string) => action('remove', () => api.removePeer(publicKey)),
    configureSsh,
    setPeerEgress,
    connectClient: (values: { serverAddress: string; joinCode: string; name?: string }) => action('connect', () => api.connectClient(values)),
    retryClient: () => action('retry', api.retryClient),
    disconnectClient: () => action('disconnect', api.disconnectClient),
  }), [state, loading, refreshing, error, busy, refresh, action, configureSsh, setPeerEgress]);
}

function statusOf(state: Snapshot): { color: string; textKey: MessageKey } {
  if (state.server.running) return { color: 'success', textKey: 'status.server' };
  if (state.client.connected) return { color: 'processing', textKey: 'status.client' };
  if (state.client.pending) return { color: 'warning', textKey: 'status.pending' };
  return { color: 'default', textKey: 'status.idle' };
}

function StatusTag({ state, t }: { state: Snapshot; t: T }) {
  const status = statusOf(state);
  const icon = state.server.running
    ? <CheckCircleOutlined />
    : state.client.connected
      ? <ApiOutlined />
      : state.client.pending
        ? <WarningOutlined />
        : undefined;
  return <Tag color={status.color} icon={icon}>{t(status.textKey)}</Tag>;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function formatBytes(value: number): string {
  const number = Number(value) || 0;
  if (number < 1024) return `${number} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KB`;
  if (number < 1024 ** 3) return `${(number / 1024 ** 2).toFixed(1)} MB`;
  return `${(number / 1024 ** 3).toFixed(2)} GB`;
}

function CopyText({ value, t, code = false }: { value: string; t: T; code?: boolean }) {
  if (!value) return <Typography.Text type="secondary">{t('page.none')}</Typography.Text>;
  return (
    <Typography.Text
      code={code}
      className={code ? 'dsh-wg-mono' : undefined}
      copyable={{ text: value, tooltips: [t('page.copy'), t('page.copied')] }}
    >
      {value}
    </Typography.Text>
  );
}

function ErrorAlert({ error, t, onClose }: { error: ApiError; t: T; onClose: () => void }) {
  const key = `error.${error.code}`;
  const mapped = t(key);
  const title = mapped === key ? t('error.title') : mapped;
  return (
    <Alert
      type="error"
      showIcon
      closable
      onClose={onClose}
      style={{ marginBottom: 16 }}
      message={title}
      description={(
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Typography.Text>{error.message}</Typography.Text>
          {error.hint ? <Typography.Text type="secondary">{t('error.hint')}: {error.hint}</Typography.Text> : null}
          {error.command ? (
            <div>
              <Typography.Text type="secondary">{t('error.command')}</Typography.Text>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <pre className="dsh-wg-command" style={{ flex: 1, minWidth: 0 }}>{error.command}</pre>
                <Button
                  type="text"
                  size="small"
                  icon={<CopyOutlined />}
                  aria-label={t('page.copy')}
                  onClick={() => void navigator.clipboard?.writeText(error.command)}
                />
              </div>
            </div>
          ) : null}
        </Space>
      )}
    />
  );
}

function ToolsBanner({
  state,
  t,
  busy,
  onInstall,
  onRecheck,
}: {
  state: Snapshot;
  t: T;
  busy: string;
  onInstall: () => void;
  onRecheck: () => void;
}) {
  if (state.tools.ready && state.tools.admin) return null;
  if (busy === 'install') {
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message={t('tools.installing')}
        description={t('install.description')}
      />
    );
  }
  if (!state.tools.ready) {
    const installHint = state.platform.id === 'win32' ? t('install.windows') : t('install.linux');
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 14 }}
        message={t('tools.missing')}
        description={(
          <div>
            <Typography.Paragraph style={{ marginBottom: 4 }}>
              {state.tools.installHint || t('tools.hint')}
            </Typography.Paragraph>
            <Typography.Text type="secondary">{installHint}</Typography.Text>
            {state.tools.missing?.length ? (
              <ul className="dsh-wg-install-list">
                {state.tools.missing.map((item) => <li key={item}><code>{item}</code></li>)}
              </ul>
            ) : null}
          </div>
        )}
        action={(
          <Space direction="vertical" size={8}>
            <Button type="primary" icon={<DownloadOutlined />} loading={busy === 'install'} onClick={onInstall}>
              {t('tools.install')}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={onRecheck}>{t('tools.recheck')}</Button>
          </Space>
        )}
      />
    );
  }
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 14 }}
      message={t('tools.adminMissing')}
      description={t('tools.adminHint')}
      action={<Button icon={<ReloadOutlined />} onClick={onRecheck}>{t('tools.recheck')}</Button>}
    />
  );
}

function ServiceForm({
  state,
  t,
  busy,
  onStart,
  onRecheck,
  onInstall,
}: {
  state: Snapshot;
  t: T;
  busy: string;
  onStart: (settings: Settings) => void;
  onRecheck: () => void;
  onInstall: () => void;
}) {
  const [form] = Form.useForm<Settings>();
  const settingsKey = JSON.stringify(state.settings);
  useEffect(() => {
    if (!state.server.running) form.setFieldsValue(state.settings);
  }, [form, settingsKey, state.server.running]);
  const blockedByClient = state.client.connected || state.client.pending;

  return (
    <Card
      className="dsh-wg-card"
      title={(
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{t('service.title')}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontWeight: 400, fontSize: 12 }}>{t('service.subtitle')}</Typography.Text>
        </Space>
      )}
      extra={<Tag>{t('status.idle')}</Tag>}
    >
      <ToolsBanner state={state} t={t} busy={busy} onInstall={onInstall} onRecheck={onRecheck} />
      <Form
        form={form}
        layout="vertical"
        initialValues={state.settings}
        onFinish={(values) => onStart(values)}
        requiredMark={false}
      >
        <Row gutter={16}>
          <Col xs={24} sm={12}>
            <Form.Item name="controlPort" label={t('service.controlPort')} rules={[{ required: true }]}>
              <InputNumber min={1024} max={65535} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="listenPort" label={t('service.listenPort')} rules={[{ required: true }]}>
              <InputNumber min={1024} max={65535} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="vpnCidr" label={t('service.vpnCidr')} rules={[{ required: true }]}>
              <Input className="dsh-wg-mono" placeholder="10.66.66.0/24" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="serverIp" label={t('service.serverIp')} rules={[{ required: true }]}>
              <Input className="dsh-wg-mono" placeholder="10.66.66.1" />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              name="endpointHost"
              label={t('service.endpointHost')}
              extra={t('service.endpointHostHelp')}
            >
              <Input className="dsh-wg-mono" placeholder={state.server.endpointHost || '192.168.1.10'} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item name="joinCode" label={t('service.joinCode')} extra={t('service.joinCodeHelp')}>
              <Input className="dsh-wg-mono" placeholder={t('service.joinCodePlaceholder')} />
            </Form.Item>
          </Col>
        </Row>

        <Collapse
          ghost
          size="small"
          items={[{
            key: 'advanced',
            label: t('service.advanced'),
            children: (
              <Row gutter={16}>
                <Col xs={24} sm={8}>
                  <Form.Item name="mtu" label={t('service.mtu')}>
                    <InputNumber min={576} max={9000} precision={0} style={{ width: '100%' }} />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={8}>
                  <Form.Item name="interfaceName" label={t('service.interface')}>
                    <Input className="dsh-wg-mono" />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={8}>
                  <Form.Item name="dns" label={t('service.dns')}>
                    <Input className="dsh-wg-mono" placeholder="1.1.1.1" />
                  </Form.Item>
                </Col>
              </Row>
            ),
          }]}
        />

        {blockedByClient ? (
          <Alert type="info" showIcon style={{ marginBottom: 14 }} message={t('service.stopClientFirst')} />
        ) : null}

        <Space wrap>
          <Button
            type="primary"
            htmlType="submit"
            icon={<CloudServerOutlined />}
            loading={busy === 'start'}
            disabled={!state.tools.ready || blockedByClient || busy === 'install'}
          >
            {busy === 'start' ? t('service.starting') : t('service.start')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={onRecheck}>{t('tools.recheck')}</Button>
        </Space>

        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          message={t('service.formHint', {
            controlPort: state.settings.controlPort,
            listenPort: state.settings.listenPort,
          })}
          description={t('service.startHint')}
        />
      </Form>
    </Card>
  );
}

function ClientDeployScript({ state, t }: { state: Snapshot; t: T }) {
  const deployment = state.deployment ?? {
    ipv4: {
      available: Boolean(state.server.controlUrl),
      controlUrl: state.server.controlUrl,
      endpoint: state.server.endpoint,
    },
    ipv6: { available: false, controlUrl: null, endpoint: null },
  };
  const [family, setFamily] = useState<'ipv4' | 'ipv6'>(() => deployment.ipv4.available ? 'ipv4' : 'ipv6');
  const [system, setSystem] = useState<'linux' | 'windows'>('linux');
  const [mode, setMode] = useState<'simple' | 'full'>('full');
  const target = deployment[family];
  useEffect(() => {
    if (target.available) return;
    if (deployment.ipv4.available) setFamily('ipv4');
    else if (deployment.ipv6.available) setFamily('ipv6');
  }, [target.available, deployment.ipv4.available, deployment.ipv6.available]);
  const simple = useMemo(() => buildLinuxClientSimpleCommand(state, target), [state, target]);
  const full = useMemo(() => buildLinuxClientCommand(state, target), [state, target]);
  const windows = useMemo(() => buildWindowsClientCommand(state, target), [state, target]);
  const command = system === 'windows' ? windows : mode === 'full' ? full : simple;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(command)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <Card
      className="dsh-wg-card"
      title={<Space><LaptopOutlined /><span>{t('service.deployTitle')}</span></Space>}
    >
      <Space wrap size={10} align="center">
        <Space size={4}>
          <Typography.Text type="secondary">{t('service.deploySystem')}</Typography.Text>
          <Select
            size="small"
            value={system}
            style={{ width: 120 }}
            onChange={(value) => setSystem(value as 'linux' | 'windows')}
            options={[
              { label: 'Linux', value: 'linux' },
              { label: 'Windows', value: 'windows' },
            ]}
          />
        </Space>
        <Space size={4}>
          <Typography.Text type="secondary">{t('service.deployFamily')}</Typography.Text>
          <Select
            size="small"
            value={family}
            style={{ width: 110 }}
            onChange={(value) => setFamily(value as 'ipv4' | 'ipv6')}
            options={[
              { label: 'IPv4', value: 'ipv4', disabled: !deployment.ipv4.available },
              { label: 'IPv6', value: 'ipv6', disabled: !deployment.ipv6.available },
            ]}
          />
        </Space>
        {system === 'linux' ? (
          <Space size={4}>
            <Typography.Text type="secondary">{t('service.deployMode')}</Typography.Text>
            <Select
              size="small"
              value={mode}
              style={{ width: 180 }}
              onChange={(value) => setMode(value as 'simple' | 'full')}
              options={[
                { label: t('service.deployFullTitle'), value: 'full' },
                { label: t('service.deploySimpleTitle'), value: 'simple' },
              ]}
            />
          </Space>
        ) : null}
        <Button
          type="primary"
          size="small"
          icon={<CopyOutlined />}
          disabled={!target.available}
          title={t('service.deployWarning')}
          onClick={() => void copy()}
        >
          {copied ? t('service.deployCopied') : t('service.deployCopy')}
        </Button>
      </Space>
      {system === 'windows' ? (
        <Alert type="info" showIcon style={{ marginTop: 12 }} message={t('service.deployWindowsNote')} />
      ) : null}
      {!target.available ? (
        <Alert type="warning" showIcon style={{ marginTop: 12 }} message={t('service.deployUnavailable')} />
      ) : null}
    </Card>
  );
}

function CopyRestartCommand({ t }: { t: T }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(LINUX_CLIENT_RESTART_COMMAND)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      title={t('service.restartHelp')}
      onClick={() => void copy()}
    >
      {copied ? t('service.restartCopied') : t('service.restartCopy')}
    </Button>
  );
}

function RunningService({
  state,
  t,
  busy,
  onStop,
  onRemove,
  onConfigureSsh,
  onSetEgress,
  members,
  gateAvailable,
}: {
  state: Snapshot;
  t: T;
  busy: string;
  onStop: () => void;
  onRemove: (publicKey: string) => void;
  onConfigureSsh: (publicKey: string, user: string, platform: 'linux' | 'windows') => Promise<{ linux: string; windows: string } | undefined>;
  onSetEgress: (publicKey: string, enabled: boolean) => Promise<EgressOutcome | undefined>;
  members: Member[];
  gateAvailable: boolean;
}) {
  const server: ServerState = state.server;
  const controlUrl = server.controlUrl || '';
  const [sshPeer, setSshPeer] = useState<Peer | null>(null);
  const [directPeer, setDirectPeer] = useState<Peer | null>(null);
  const [sshUser, setSshUser] = useState('root');
  const [sshPlatform, setSshPlatform] = useState<'linux' | 'windows'>('linux');
  const [sshCommands, setSshCommands] = useState<{ linux: string; windows: string } | null>(null);
  const [sshError, setSshError] = useState('');
  const [sshCopied, setSshCopied] = useState(false);
  const [egressOutcome, setEgressOutcome] = useState<{ peer: Peer; enabled: boolean; result: EgressOutcome } | null>(null);
  const [egressCopied, setEgressCopied] = useState(false);
  const egressCommand = egressOutcome
    ? (egressOutcome.enabled ? egressOutcome.result.manual?.enable : egressOutcome.result.manual?.disable) || ''
    : '';
  const toggleEgress = async (peer: Peer) => {
    const enabled = !peer.egress;
    const result = await onSetEgress(peer.publicKey, enabled);
    if (result && result.applied === false && result.manual) {
      setEgressCopied(false);
      setEgressOutcome({ peer, enabled, result });
    }
  };
  const columns: ColumnsType<Peer> = [
    {
      title: t('service.peerName'),
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (_value, peer) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{peer.name}</Typography.Text>
          <Typography.Text type="secondary" className="dsh-wg-mono">{peer.publicKeyFingerprint}</Typography.Text>
        </Space>
      ),
    },
    {
      title: t('service.peerIp'),
      dataIndex: 'ip',
      key: 'ip',
      width: 110,
      render: (value) => <Typography.Text className="dsh-wg-mono">{value}</Typography.Text>,
    },
    {
      title: t('service.peerStatus'),
      key: 'status',
      width: 100,
      render: (_value, peer) => {
        if (!peer.applied) return <Badge status="warning" text={t('service.pendingApply')} />;
        return peer.online
          ? <Badge status="success" text={t('service.online')} />
          : <Badge status="default" text={t('service.offline')} />;
      },
    },
    {
      title: t('service.peerEgress'),
      key: 'egress',
      width: 170,
      render: (_value, peer) => (
        <Space direction="vertical" size={0}>
          <Space size={4}>
            <GlobalOutlined style={peer.egress ? { color: '#52c41a' } : { color: 'var(--dsw-alias-label-tertiary)' }} />
            <Typography.Text type={peer.egress ? undefined : 'secondary'}>
              {peer.egress ? t('service.egressOn') : t('service.egressOff')}
            </Typography.Text>
            <Button
              size="small"
              type="link"
              loading={busy === 'egress'}
              onClick={() => void toggleEgress(peer)}
            >
              {peer.egress ? t('service.egressDisable') : t('service.egressEnable')}
            </Button>
          </Space>
          {peer.egress && !peer.sshConfigured ? (
            <Typography.Text type="warning" style={{ fontSize: 11 }}>{t('service.egressNoSsh')}</Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: t('service.peerHandshake'),
      dataIndex: 'lastHandshakeAt',
      key: 'lastHandshakeAt',
      width: 150,
      render: (value) => value
        ? <Typography.Text type="secondary">{formatTime(value)}</Typography.Text>
        : <Typography.Text type="warning">{t('service.neverHandshake')}</Typography.Text>,
    },
    {
      title: t('service.peerActions'),
      key: 'actions',
      width: 190,
      align: 'right',
      render: (_value, peer) => (
        <Space size={2}>
          <Button
            type="text"
            size="small"
            icon={<LinkOutlined />}
            title={t('service.direct')}
            onClick={() => setDirectPeer(peer)}
          >
            {t('service.direct')}
          </Button>
          <Button
            type="text"
            size="small"
            icon={<KeyOutlined />}
            title={peer.sshReady
              ? t('service.sshReady', { user: peer.sshUser || '' })
              : peer.sshInstalled
                ? `${t('service.sshUnhealthy')}${peer.sshError ? `: ${peer.sshError}` : ''}`
                : t('service.sshNotInstalled')}
            style={peer.sshReady ? { color: '#52c41a' } : peer.sshInstalled ? { color: '#faad14' } : undefined}
            onClick={() => {
              setSshPeer(peer);
              setSshUser(peer.sshUser || (peer.platform === 'windows' ? 'Administrator' : 'root'));
              setSshPlatform(peer.platform === 'windows' ? 'windows' : 'linux');
              setSshCommands(null);
              setSshError('');
              setSshCopied(false);
            }}
          >
            SSH
          </Button>
          <Popconfirm
            title={t('service.removeConfirm')}
            okText={t('service.remove')}
            cancelText={t('page.cancel')}
            onConfirm={() => onRemove(peer.publicKey)}
          >
            <Button type="text" danger icon={<DeleteOutlined />} loading={busy === 'remove'} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        className="dsh-wg-card"
        title={(
          <Space>
            <CheckCircleOutlined style={{ color: '#52c41a' }} />
            <span>{t('service.running')}</span>
          </Space>
        )}
        extra={(
          <Popconfirm
            title={t('service.stopConfirm')}
            okText={t('service.stop')}
            cancelText={t('page.cancel')}
            onConfirm={onStop}
          >
            <Button size="small" danger icon={<StopOutlined />} loading={busy === 'stop'}>
              {t('service.stop')}
            </Button>
          </Popconfirm>
        )}
      >
        <Descriptions bordered size="small" column={{ xs: 1, sm: 1, md: 2 }} style={{ marginTop: 0 }}>
          <Descriptions.Item label={t('service.controlAddress')} span={2}>
            <CopyText value={controlUrl} t={t} />
          </Descriptions.Item>
          <Descriptions.Item label={t('service.endpoint')}>
            <Typography.Text className="dsh-wg-mono">{server.endpoint || t('page.none')}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('service.vpnAddress')}>
            <Typography.Text className="dsh-wg-mono">{state.settings.serverIp} · {server.vpnCidr}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('service.publicKey')} span={2}>
            <CopyText value={server.publicKey} t={t} code />
          </Descriptions.Item>
          <Descriptions.Item label={t('service.joinCode')} span={2}>
            {server.joinRequired
              ? <CopyText value={state.settings.joinCode} t={t} code />
              : <Typography.Text type="secondary">{t('service.joinCodeNone')}</Typography.Text>}
          </Descriptions.Item>
        </Descriptions>

        {server.warnings?.length ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 14 }}
            message={t('service.warning')}
            description={(
              <ul className="dsh-wg-warning-list">
                {server.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            )}
          />
        ) : null}
      </Card>

      {server.peers.some((peer) => peer.applied && !peer.lastHandshakeAt) ? (
        <Alert
          type="warning"
          showIcon
          message={t('service.handshakeWarning')}
          description={t('service.handshakeWarningHelp', { port: server.listenPort })}
        />
      ) : null}

      <Card
        className="dsh-wg-card"
        title={t('service.peers')}
        extra={(
          <Space size={8} wrap>
            <Typography.Text type="secondary">{t('service.peerCount', { count: server.peers.length })}</Typography.Text>
            <CopyRestartCommand t={t} />
          </Space>
        )}
      >
        <Table<Peer>
          rowKey="publicKey"
          columns={columns}
          dataSource={server.peers}
          pagination={false}
          size="small"
          scroll={{ x: 760 }}
          locale={{
            emptyText: <Empty className="dsh-wg-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('service.noPeers')} />,
          }}
        />
      </Card>

      <ClientDeployScript state={state} t={t} />
      </Space>
      <Modal
        open={sshPeer !== null}
        title={t('service.sshTitle')}
        onCancel={() => setSshPeer(null)}
        footer={null}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">{t('service.sshHelp')}</Typography.Paragraph>
        <Alert
          type={sshPeer?.sshReady ? 'success' : 'info'}
          showIcon
          style={{ marginBottom: 12 }}
          message={sshPeer?.sshReady
            ? t('service.sshReady', { user: sshPeer.sshUser || '' })
            : t('service.sshAutoHelp')}
          description={sshPeer?.sshError || undefined}
        />
        <Typography.Text strong>{t('service.sshUser')}</Typography.Text>
        <Input
          value={sshUser}
          onChange={(event) => {
            setSshUser(event.target.value);
            setSshCommands(null);
            setSshError('');
            setSshCopied(false);
          }}
          placeholder="root"
          style={{ marginTop: 6 }}
        />
        <Tabs
          size="small"
          activeKey={sshPlatform}
          onChange={(key) => {
            const platform = key as 'linux' | 'windows';
            setSshPlatform(platform);
            setSshCommands(null);
            setSshCopied(false);
            if (platform === 'windows' && sshUser === 'root') setSshUser('Administrator');
            if (platform === 'linux' && sshUser === 'Administrator') setSshUser('root');
          }}
          items={[
            { key: 'linux', label: t('service.sshLinux') },
            { key: 'windows', label: t('service.sshWindows') },
          ]}
          style={{ marginTop: 10 }}
        />
        {sshPlatform === 'windows' ? (
          <Alert type="info" showIcon style={{ marginBottom: 10 }} message={t('service.sshWindowsHelp')} />
        ) : null}
        {sshError ? <Alert type="error" showIcon style={{ marginTop: 12 }} message={sshError} /> : null}
        <Alert type="info" showIcon style={{ marginTop: 12 }} message={t('service.sshPrivateNote')} />
        {sshCommands !== null ? (
          <pre className="dsh-wg-command" style={{ marginTop: 12, maxHeight: 150, overflow: 'auto' }}>
            {sshCommands[sshPlatform]}
          </pre>
        ) : null}
        {sshCopied ? <Alert type="success" showIcon style={{ marginTop: 12 }} message={t('service.sshCopied')} /> : null}
        <Button
          type="primary"
          block
          style={{ marginTop: 14 }}
          loading={busy === 'ssh'}
          disabled={!SSH_USER_RE.test(sshUser.trim())}
          onClick={async () => {
            if (!sshPeer) return;
            const user = sshUser.trim();
            if (!SSH_USER_RE.test(user)) {
              setSshError(t('service.sshInvalidUser'));
              return;
            }
            let commands = sshCommands;
            if (commands === null) {
              const next = await onConfigureSsh(sshPeer.publicKey, user, sshPlatform);
              if (!next) return;
              commands = next;
              setSshCommands(next);
            }
            if (await copyToClipboard(commands[sshPlatform])) {
              setSshCopied(true);
            } else {
              setSshError(t('service.sshCopyFailed'));
            }
          }}
        >
          {sshCommands === null ? t('service.sshGenerate') : t('service.sshCopy')}
        </Button>
      </Modal>
      <DirectLinksModal
        open={directPeer !== null}
        peer={directPeer === null ? null : { name: directPeer.name, ip: directPeer.ip, platform: directPeer.platform } satisfies DirectLinkPeer}
        members={members}
        gateAvailable={gateAvailable}
        onClose={() => setDirectPeer(null)}
      />
      <Modal
        open={egressOutcome !== null}
        title={t('service.egressTitle')}
        onCancel={() => setEgressOutcome(null)}
        footer={null}
        destroyOnHidden
        width={720}
      >
        <Typography.Paragraph type="secondary">{t('service.egressHelp')}</Typography.Paragraph>
        {egressOutcome?.result.reason ? (
          <Alert type="warning" showIcon message={egressOutcome.result.reason} />
        ) : null}
        <Typography.Text strong>
          {egressOutcome?.enabled ? t('service.egressManualEnable') : t('service.egressManualDisable')}
        </Typography.Text>
        <pre className="dsh-wg-command" style={{ maxHeight: 220, overflow: 'auto' }}>{egressCommand}</pre>
        {egressCopied ? <Alert type="success" showIcon style={{ marginTop: 12 }} message={t('service.egressCopied')} /> : null}
        <Space style={{ marginTop: 14 }}>
          <Button
            type="primary"
            icon={<CopyOutlined />}
            onClick={async () => {
              if (await copyToClipboard(egressCommand)) setEgressCopied(true);
            }}
          >
            {t('service.egressCopy')}
          </Button>
          <Button onClick={() => setEgressOutcome(null)}>{t('page.close')}</Button>
        </Space>
      </Modal>
    </>
  );
}

function ClientForm({
  state,
  t,
  busy,
  onConnect,
  onRecheck,
  onInstall,
}: {
  state: Snapshot;
  t: T;
  busy: string;
  onConnect: (values: { serverAddress: string; joinCode: string; name?: string }) => void;
  onRecheck: () => void;
  onInstall: () => void;
}) {
  const [form] = Form.useForm<{ serverAddress: string; joinCode: string }>();
  const blockedByServer = state.server.running;
  return (
    <Card
      className="dsh-wg-card"
      title={(
        <Typography.Text strong>{t('client.title')}</Typography.Text>
      )}
      extra={<Tag icon={<LaptopOutlined />}>{t('status.idle')}</Tag>}
    >
      <ToolsBanner state={state} t={t} busy={busy} onInstall={onInstall} onRecheck={onRecheck} />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ serverAddress: state.client.serverHost || '', joinCode: '' }}
        onFinish={(values) => onConnect({ ...values, name: state.hostname })}
        requiredMark={false}
      >
        <Form.Item
          name="serverAddress"
          label={t('client.serverAddress')}
          rules={[{ required: true, message: t('client.serverAddressPlaceholder') }]}
        >
          <Input
            className="dsh-wg-mono"
            placeholder={t('client.serverAddressPlaceholder')}
            prefix={<GlobalOutlined />}
          />
        </Form.Item>
        <Form.Item
          name="joinCode"
          label={t('client.joinCode')}
        >
          <Input className="dsh-wg-mono" placeholder={t('client.joinCodePlaceholder')} />
        </Form.Item>

        {blockedByServer ? (
          <Alert type="info" showIcon style={{ marginBottom: 14 }} message={t('client.stopServerFirst')} />
        ) : null}

        <Space wrap>
          <Button
            type="primary"
            htmlType="submit"
            icon={<ApiOutlined />}
            loading={busy === 'connect'}
            disabled={!state.tools.ready || blockedByServer || busy === 'install'}
          >
            {busy === 'connect' ? t('client.connecting') : t('client.connect')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={onRecheck}>{t('tools.recheck')}</Button>
        </Space>
      </Form>
    </Card>
  );
}

function ClientConnected({
  state,
  t,
  busy,
  onDisconnect,
}: {
  state: Snapshot;
  t: T;
  busy: string;
  onDisconnect: () => void;
}) {
  const client: ClientState = state.client;
  return (
    <Card
      className="dsh-wg-card"
      title={(
        <Space>
          <CheckCircleOutlined style={{ color: '#52c41a' }} />
          <span>{t('client.connectedTitle')}</span>
        </Space>
      )}
      extra={<Tag color="processing">{t('status.client')}</Tag>}
    >
      <Typography.Text type="secondary">{t('client.assignedIp')}</Typography.Text>
      <Typography.Title level={1} className="dsh-wg-ip" copyable={{ text: client.assignedIp || '' }}>
        {client.assignedIp || t('page.none')}
      </Typography.Title>
      <Typography.Text type="secondary">
        {t('client.connectedAs', { name: client.name || state.hostname })}
      </Typography.Text>

      <Descriptions bordered size="small" column={{ xs: 1, sm: 1, md: 2 }} style={{ marginTop: 16 }}>
        <Descriptions.Item label={t('client.server')}>
          <CopyText value={client.serverHost || client.serverUrl || ''} t={t} />
        </Descriptions.Item>
        <Descriptions.Item label={t('client.endpoint')}>
          <Typography.Text className="dsh-wg-mono">{client.endpoint || t('page.none')}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('client.publicKey')} span={2}>
          <CopyText value={client.serverPublicKey || ''} t={t} code />
        </Descriptions.Item>
        <Descriptions.Item label={t('client.lastHandshake')}>
          {formatTime(client.lastHandshakeAt)}
        </Descriptions.Item>
        <Descriptions.Item label={t('client.traffic')}>
          <Typography.Text className="dsh-wg-mono">
            ↓ {formatBytes(client.receivedBytes)} · ↑ {formatBytes(client.sentBytes)}
          </Typography.Text>
        </Descriptions.Item>
      </Descriptions>

      <Popconfirm
        title={t('client.disconnectConfirm')}
        okText={t('client.disconnect')}
        cancelText={t('client.cancel')}
        onConfirm={onDisconnect}
      >
        <Button danger icon={<StopOutlined />} loading={busy === 'disconnect'} style={{ marginTop: 16 }}>
          {t('client.disconnect')}
        </Button>
      </Popconfirm>
    </Card>
  );
}

function ClientPending({
  state,
  t,
  busy,
  onRetry,
  onCancel,
}: {
  state: Snapshot;
  t: T;
  busy: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <Card className="dsh-wg-card">
      <Result
        status="warning"
        title={t('client.pendingTitle')}
        subTitle={state.client.lastError || t('client.pendingSub')}
        extra={(
          <Space wrap>
            <Button type="primary" onClick={onRetry} loading={busy === 'retry'}>
              {t('client.retry')}
            </Button>
            <Button onClick={onCancel} loading={busy === 'disconnect'}>
              {t('client.cancel')}
            </Button>
          </Space>
        )}
      >
        <Descriptions column={1} size="small">
          <Descriptions.Item label={t('client.assignedIp')}>
            <Typography.Text className="dsh-wg-mono">{state.client.assignedIp || t('page.none')}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('client.server')}>
            <Typography.Text className="dsh-wg-mono">{state.client.serverHost || state.client.serverUrl || t('page.none')}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label={t('client.endpoint')}>
            <Typography.Text className="dsh-wg-mono">{state.client.endpoint || t('page.none')}</Typography.Text>
          </Descriptions.Item>
        </Descriptions>
      </Result>
    </Card>
  );
}

export function WireGuardPanel({
  ctx,
  embedded = false,
  t: providedT,
  members = [],
  gateAvailable = false,
  refreshToken = 0,
}: {
  ctx: any;
  embedded?: boolean;
  t?: (key: string) => string;
  members?: Member[];
  gateAvailable?: boolean;
  refreshToken?: number;
}) {
  const t = useT(ctx, providedT);
  const mode = useThemeMode(ctx);
  const controller = useController(ctx);
  const { state, loading, refreshing, error, busy } = controller;
  const [tab, setTab] = useState<TabKey>('service');
  const lastRefreshToken = useRef(0);

  // The mesh tab bar owns the refresh icon; only the active click should hit
  // the host, so compare against the last token instead of the controller
  // identity (which changes after every state update).
  useEffect(() => {
    if (refreshToken === 0 || refreshToken === lastRefreshToken.current) return;
    lastRefreshToken.current = refreshToken;
    void controller.refresh(false);
  }, [refreshToken, controller]);

  useEffect(() => {
    if (state?.role === 'client') setTab('client');
    if (state?.role === 'server') setTab('service');
  }, [state?.role]);

  const locale = ctx.locale.getSnapshot().active || '';
  const isZh = locale.toLowerCase().startsWith('zh');

  const serviceTab = state ? (
    state.server.running ? (
      <RunningService
        state={state}
        t={t}
        busy={busy}
        onStop={() => void controller.stopServer()}
        onRemove={(publicKey) => void controller.removePeer(publicKey)}
        onConfigureSsh={controller.configureSsh}
        onSetEgress={controller.setPeerEgress}
        members={members}
        gateAvailable={gateAvailable}
      />
    ) : (
      <ServiceForm
        state={state}
        t={t}
        busy={busy}
        onStart={(settings) => void controller.startServer(settings)}
        onRecheck={() => void controller.recheck()}
        onInstall={() => void controller.install()}
      />
    )
  ) : null;

  const clientTab = state ? (
    state.client.connected ? (
      <ClientConnected
        state={state}
        t={t}
        busy={busy}
        onDisconnect={() => void controller.disconnectClient()}
      />
    ) : state.client.pending ? (
      <ClientPending
        state={state}
        t={t}
        busy={busy}
        onRetry={() => void controller.retryClient()}
        onCancel={() => void controller.disconnectClient()}
      />
    ) : (
      <ClientForm
        state={state}
        t={t}
        busy={busy}
        onConnect={(values) => void controller.connectClient(values)}
        onRecheck={() => void controller.recheck()}
        onInstall={() => void controller.install()}
      />
    )
  ) : null;

  return (
    <ConfigProvider
      locale={isZh ? zhCN : enUS}
      theme={{
        algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#2f7cff',
          borderRadius: 10,
          fontSize: 13,
          colorBgLayout: 'transparent',
        },
      }}
    >
      <style>{styles}</style>
      <div className={embedded ? 'dsh-wg-root dsh-wg-embedded' : 'dsh-wg-root'}>
        <div className="dsh-wg-shell">
          <Flex className="dsh-wg-header" align="flex-start" gap={14} wrap>
            <div className="dsh-wg-mark"><SafetyCertificateOutlined /></div>
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <Typography.Title level={3} className="dsh-wg-title">{t('page.title')}</Typography.Title>
              <Typography.Text type="secondary" className="dsh-wg-subtitle">{t('page.subtitle')}</Typography.Text>
            </div>
            <Space wrap>
              {state ? <StatusTag state={state} t={t} /> : null}
              <Button
                icon={<ReloadOutlined />}
                loading={refreshing}
                onClick={() => void controller.refresh(false)}
              >
                {t('page.refresh')}
              </Button>
            </Space>
          </Flex>

          {error ? <ErrorAlert error={error} t={t} onClose={controller.clearError} /> : null}

          {loading && !state ? (
            <Card className="dsh-wg-card">
              <Spin tip={t('page.loading')} size="large">
                <div style={{ height: 140 }} />
              </Spin>
            </Card>
          ) : !state ? (
            <Card className="dsh-wg-card">
              <Result
                status="warning"
                title={t('page.backendError')}
                extra={<Button type="primary" onClick={() => void controller.refresh(true)}>{t('page.retry')}</Button>}
              />
            </Card>
          ) : (
            <>
              <Tabs
                className="dsh-wg-tabs"
                activeKey={tab}
                onChange={(key) => setTab(key as TabKey)}
                items={[
                  {
                    key: 'service',
                    label: <Space><CloudServerOutlined />{t('tabs.service')}</Space>,
                    children: serviceTab,
                  },
                  {
                    key: 'client',
                    label: <Space><LaptopOutlined />{t('tabs.client')}</Space>,
                    children: clientTab,
                  },
                ]}
              />
              <div className="dsh-wg-footer">
                <span>{t('common.platform')}: {state.platform.label}</span>
                <span>{t('common.version')}: {state.version}</span>
                <span>{t('common.hostname')}: {state.hostname}</span>
                <span>{t('tools.ready')}: {state.tools.ready ? '✓' : '✕'}</span>
                <span>{t('tools.admin')}: {state.tools.admin ? '✓' : '✕'}</span>
                {state.logs?.length ? (
                  <details>
                    <summary>{t('common.logs')}</summary>
                    <pre className="dsh-wg-command">{state.logs.slice(-8).join('\n')}</pre>
                  </details>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </ConfigProvider>
  );
}

