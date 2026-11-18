/** Typed surface of the embedded interop service for the Host entry. */

export interface InteropSettings {
  readonly file: string | null
  readonly root: string | null
  readonly dataDir: string
  readonly stateFile: string
  readonly logFile: string
  readonly token: string
  readonly bind: string
  readonly port: number
  readonly provider: string
  readonly model: string
  readonly approve: boolean
  readonly preset: string
  readonly agentPreset: string
  readonly workdir: string
  /** Root below which a `workspace` name resolves (default `~/.dsh/workspaces`). */
  readonly workspaceRoot: string
  readonly tokenSource: string
  [key: string]: unknown
}

export interface InteropService {
  readonly settings: InteropSettings
  readonly conversations: Map<string, Record<string, unknown>>
  readonly listening: boolean
  start(): Promise<{ port: number }>
  dispose(): Promise<void>
}

export function readEnvFile(file: string): Record<string, string>
export function findInteropConfig(): string | null
export function resolveInteropSettings(config?: Record<string, unknown>): InteropSettings
export function createInteropService(options: {
  ctx: unknown
  settings?: InteropSettings
  config?: Record<string, unknown>
  log?: (line: string) => void
  retry?: boolean
}): InteropService
