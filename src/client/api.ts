/** Browser API for the mesh panel. */

export interface SystemInfo {
  hostname?: string
  platform?: string
  arch?: string
  home?: string
  appRoot?: string
  user?: string
  cpu?: { model?: string; cores?: number; usagePercent?: number }
  memory?: { totalBytes?: number; usedBytes?: number; usedPercent?: number }
  disks?: Array<{ mount?: string; totalBytes?: number; usedBytes?: number; freeBytes?: number; availableBytes?: number; usedPercent?: number }>
}

export interface Member {
  id: string
  kind: 'self' | 'peer'
  name: string
  ip: string
  online: boolean
  dsh: boolean
  port: number | null
  latencyMs: number
  lastHandshakeAt: string | null
  gate: Record<string, unknown> | null
  system?: SystemInfo | null
  tag?: string | null
  error: string | null
}

export interface MemberTags {
  ok: boolean
  tags: Record<string, string>
}

export interface Snapshot {
  ok: boolean
  updatedAt: string
  target: string
  local: Member
  members: Member[]
  warnings: string[]
  source?: Record<string, unknown>
  cluster?: { configured: boolean; memberPort: number }
}

export interface MemberConversation {
  id: string
  sessionId?: string
  title?: string
  initiator?: { id?: string; name?: string; ip?: string; source?: string } | null
  status?: string
  createdAt?: string
  updatedAt?: string
  lastText?: string
  turns?: number
  eventCount?: number
  cwd?: string
  error?: string | null
}

export interface ConversationGroup {
  id: string
  name: string
  ip: string
  online: boolean
  self: boolean
  dsh: boolean
  conversations: MemberConversation[]
  error: string | null
}

/** One member that accepted a panel message. */
export interface SendOutcome {
  member: string
  ip: string
  conversationId: string
  /** true when the text joined a conversation that was already running. */
  reused: boolean
}

export interface SendResult {
  ok: boolean
  sent: SendOutcome[]
  errors: Array<{ member: string; ip: string; error: string }>
}

export interface ConversationSnapshot {
  ok: boolean
  updatedAt: string
  groups: ConversationGroup[]
}

export interface HostStatus {
  ok: boolean
  host: {
    hostname: string
    platform: string
    arch: string
    version: string
    dataDir: string
  }
  wireguard: {
    available: boolean
    role?: 'client' | 'server'
    connected?: boolean
    vpnCidr?: string
    serverIp?: string
    serverUrl?: string
    selfIp?: string
    selfName?: string
    warnings?: string[]
    error?: string | null
  }
  gate: { url: string }
  build: {
    source: string
    ref: string
    targets: string[]
    jobRoot: string
  }
}

export interface BuildJob {
  id: string
  status: string
  phase: string
  source: string
  ref: string
  targets: string[]
  createdAt?: string
  updatedAt: string
  error?: string | null
  workOrder?: { markdown?: string; json?: string; prompt?: string } | null
  workOrderMarkdown?: string | null
  workOrderPrompt?: string | null
  logTail?: string[]
  running?: boolean
  learnedAt?: string | null
  artifacts?: Array<{ target: string; archive: string; bytes: number }>
}

export interface PackageInfo {
  name: string
  path: string
  bytes: number
  mtime: string
  target: 'linux' | 'windows'
}

export interface PackagesResponse {
  ok: boolean
  dir: string
  packages: PackageInfo[]
}

export interface DeployStep {
  key: string
  label: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  startedAt: string | null
  finishedAt: string | null
  detail: string
  progress?: { done: number; total: number; percent: number } | null
}

export interface DeployProgress {
  /** What the meter measures: the upload's bytes, then the extraction's entries. */
  label?: string
  bytes: number
  totalBytes: number
  percent: number
  speed: number
  /** Archive entries, used while the package is being extracted. */
  done?: number
  total?: number
  indeterminate: boolean
}

export interface DeployJob {
  id: string
  createdAt: string
  updatedAt?: string
  member?: string | null
  release: string
  package?: string
  services?: string[]
  target: { host: string; user?: string | null; port: number; os: string; appRoot: string }
  status: 'running' | 'succeeded' | 'failed' | string
  phase: string
  error: string | null
  steps?: DeployStep[]
  progress?: DeployProgress
}

export interface DeployResponse {
  ok: boolean
  job: DeployJob
  member: { id: string; name: string; ip: string }
  packagesDir: string
}

/**
 * `starting` and `offline` mean the host did not answer with JSON at all: the
 * gate serves an HTML page while DSH boots, and a restart can also drop the
 * connection outright. Both are transient, so the panel shows a friendly hint
 * and retries instead of surfacing the raw page.
 */
export type ApiErrorKind = 'starting' | 'offline' | 'auth'

export const STARTING_MESSAGE = 'DeepSeek Harness 正在启动，请稍等几秒再试。'
export const OFFLINE_MESSAGE = '无法连接到服务，可能正在重启或网络中断，请稍后刷新重试。'

export class ApiError extends Error {
  status: number
  kind?: ApiErrorKind

  constructor(message: string, status: number, kind?: ApiErrorKind) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.kind = kind
  }
}

/** True when a failed call only means the host is not ready yet. */
export function isStartingError(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === 'starting' || error.kind === 'offline')
}

function looksLikeHtml(text: string, contentType: string): boolean {
  if (contentType.includes('text/html')) return true
  return /^<(?:!doctype\s+html|html|head|body)/i.test(text.trimStart())
}

/** Explain a non-JSON answer instead of dumping the page source into the UI. */
function describeNonJson(status: number, text: string, contentType: string): ApiError {
  if (status === 0 || status >= 500) return new ApiError(STARTING_MESSAGE, status, 'starting')
  if (looksLikeHtml(text, contentType)) return new ApiError('登录状态已失效，请刷新页面重新登录。', status, 'auth')
  return new ApiError(text.slice(0, 300) || `HTTP ${String(status)}`, status)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError(OFFLINE_MESSAGE, 0, 'offline')
  }
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  let body: unknown
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    throw describeNonJson(response.status, text, contentType)
  }
  if (!response.ok) {
    const hasError = body !== null && typeof body === 'object' && 'error' in body
    if (!hasError && (response.status >= 500 || response.status === 0)) {
      throw new ApiError(STARTING_MESSAGE, response.status, 'starting')
    }
    const detail = hasError ? (body as { error: unknown }).error : undefined
    const message = typeof detail === 'string'
      ? detail
      : (detail !== null && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string'
        ? (detail as { message: string }).message
        : `HTTP ${String(response.status)}`)
    throw new ApiError(message, response.status)
  }
  return body as T
}

export const api = {
  /** Read the gate's member snapshot, or null when this page is not behind a gate. */
  async gateStatus(): Promise<Snapshot | null> {
    try {
      return await request<Snapshot>('/__gate/status')
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 401 || error.status === 403)) return null
      throw error
    }
  },

  /** Switch the gate's target cookie. The caller reloads afterwards. */
  async gateSelect(id: string): Promise<void> {
    await request<{ ok: boolean }>('/__gate/select', {
      method: 'POST',
      headers: { 'x-dsh-gate': '1' },
      body: JSON.stringify({ id }),
    })
  },

  /** Clear the target cookie and return to the local DSH. */
  gateReset(): void {
    window.location.href = '/__gate/reset'
  },

  hostStatus(): Promise<HostStatus> {
    return request<HostStatus>('/api/dsh-mesh/status')
  },

  hostMembers(): Promise<Snapshot> {
    return request<Snapshot>('/api/dsh-mesh/members')
  },

  memberTags(): Promise<MemberTags> {
    return request<MemberTags>('/api/dsh-mesh/member-tags')
  },

  setMemberTag(id: string, tag: string): Promise<MemberTags> {
    return request<MemberTags>('/api/dsh-mesh/member-tags', {
      method: 'POST',
      headers: { 'x-dsh-mesh': '1' },
      body: JSON.stringify({ id, tag }),
    })
  },

  packages(): Promise<PackagesResponse> {
    return request<PackagesResponse>('/api/dsh-mesh/packages')
  },

  deploy(member: string, packageName: string): Promise<DeployResponse> {
    return request<DeployResponse>('/api/dsh-mesh/deploy', {
      method: 'POST',
      headers: { 'x-dsh-mesh': '1' },
      body: JSON.stringify({ member, package: packageName }),
    })
  },

  jobs(): Promise<{ jobs: BuildJob[] }> {
    return request<{ jobs: BuildJob[] }>('/api/dsh-mesh/jobs')
  },

  deployJobs(): Promise<{ jobs: DeployJob[] }> {
    return request<{ jobs: DeployJob[] }>('/api/dsh-mesh/deploy/jobs')
  },

  deployJob(id: string, lines = 200): Promise<{ job: DeployJob; lines: string[] }> {
    return request<{ job: DeployJob; lines: string[] }>(
      `/api/dsh-mesh/deploy/${encodeURIComponent(id)}?lines=${String(lines)}`,
    )
  },

  startBuild(body: { source?: string; ref?: string; targets?: string[]; planOnly?: boolean }): Promise<{ job: BuildJob }> {
    return request<{ job: BuildJob }>('/api/dsh-mesh/build', {
      method: 'POST',
      headers: { 'x-dsh-mesh': '1' },
      body: JSON.stringify(body),
    })
  },

  promoteSession(member: string): Promise<{ ok: boolean; member: { id: string; name: string; ip: string }; status: Record<string, unknown> | null }> {
    return request('/api/dsh-mesh/session/promote', {
      method: 'POST',
      headers: { 'x-dsh-mesh': '1' },
      body: JSON.stringify({ member }),
    })
  },

  /**
   * Post a message from the panel. An empty member list means every member.
   */
  sendConversation(text: string, members: string[]): Promise<SendResult> {
    return request<SendResult>('/api/dsh-mesh/conversations/send', {
      method: 'POST',
      body: JSON.stringify({ text, members }),
    })
  },

  conversations(): Promise<ConversationSnapshot> {
    return request<ConversationSnapshot>('/api/dsh-mesh/conversations')
  },

  clearConversations(): Promise<{ ok: boolean; removed: number; errors: Array<{ member: string; error: string }> }> {
    return request<{ ok: boolean; removed: number; errors: Array<{ member: string; error: string }> }>(
      '/api/dsh-mesh/conversations/clear',
      { method: 'POST' },
    )
  },

  job(id: string): Promise<{ job: BuildJob }> {
    return request<{ job: BuildJob }>(`/api/dsh-mesh/build/${encodeURIComponent(id)}`)
  },

  log(id: string, lines = 120): Promise<{ lines: string[] }> {
    return request<{ lines: string[] }>(`/api/dsh-mesh/build/${encodeURIComponent(id)}/log?lines=${String(lines)}`)
  },

  learn(id: string): Promise<{ job: BuildJob }> {
    return request<{ job: BuildJob }>(`/api/dsh-mesh/build/${encodeURIComponent(id)}/learn`, {
      method: 'POST',
      headers: { 'x-dsh-mesh': '1' },
    })
  },

  resume(id: string): Promise<{ job: BuildJob }> {
    return request<{ job: BuildJob }>(`/api/dsh-mesh/build/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      headers: { 'x-dsh-mesh': '1' },
    })
  },
}
