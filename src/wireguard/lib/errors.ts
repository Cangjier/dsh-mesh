/** Structured failures that survive the Host HTTP boundary. */

/**
 * An expected WireGuard operation failure with an actionable code.
 */
export interface WireGuardErrorOptions {
  status?: number;
  hint?: string;
  command?: string;
  details?: unknown;
  cause?: unknown;
}

export class WireGuardError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint?: string;
  readonly command?: string;
  readonly details?: unknown;

  constructor(code: string, message: string, options: WireGuardErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WireGuardError';
    this.code = code;
    this.status = options.status ?? 400;
    this.hint = options.hint;
    this.command = options.command;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    const body: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.hint) body.hint = this.hint;
    if (this.command) body.command = this.command;
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

/**
 * Build the standard message for a missing platform tool.
 * @param {string} tool command name.
 * @param {'win32' | 'linux' | string} platform process platform.
 * @returns {string} actionable guidance.
 */
export function missingToolHint(tool: string, platform: string): string {
  if (platform === 'win32') {
    return `Install the official WireGuard client from https://www.wireguard.com/install/ and restart Harness. Expected ${tool} in C:\\Program Files\\WireGuard.`;
  }
  if (platform === 'linux') {
    return `Install WireGuard tools (for example: sudo apt install wireguard iproute2), then restart Harness. Missing: ${tool}.`;
  }
  return `WireGuard is supported on Windows and Linux; this host reports ${platform}.`;
}
