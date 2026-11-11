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
  bytes: number
  totalBytes: number
  percent: number
  speed: number
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

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new ApiError(text.slice(0, 300) || `HTTP ${String(response.status)}`, response.status)
  }
  if (!response.ok) {
    const message = body !== null && typeof body === 'object' && 'error' in body
      ? typeof body.error === 'string'
        ? body.error
        : (body.error as { message?: string }).message ?? JSON.stringify(body.error)
      : `HTTP ${String(response.status)}`
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
