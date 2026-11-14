/**
 * Two-way SSH material for WireGuard members.
 *
 * The gateway has always kept one private key per peer and installed the
 * matching public key on the member, so the gateway can log in to every member.
 * The reverse direction needs its own material: the member owns the private
 * key, and the gateway only keeps the public half in authorized_keys. Keeping
 * the builders here (instead of inside the service) lets the control service,
 * the standalone member agent, and the tests share one wire format.
 */

import { createHash } from 'node:crypto';

/** Key file the member keeps its own identity in (under ~/.ssh). */
export const MEMBER_KEY_NAME = 'id_ed25519_dsh_mesh';

/** Marker pair used to own one block of ~/.ssh/config without clobbering it. */
export const GATEWAY_BLOCK_NAME = 'dsh-mesh:gateway';

/** Comment suffix that tags an authorized_keys line as belonging to one peer. */
export const AUTHORIZED_KEY_TAG_PREFIX = 'dsh-mesh:';

/** Key types a member may present. Everything else is rejected outright. */
const SSH_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export interface SshPublicKey {
  /** Key algorithm, for example `ssh-ed25519`. */
  type: string;
  /** Base64 encoded key blob. */
  base64: string;
  /** Free-form trailing comment, possibly empty. */
  comment: string;
  /** Canonical `type base64` text without the comment. */
  text: string;
}

/**
 * Parse and validate one OpenSSH public key line.
 * @param value candidate text, typically the contents of a `.pub` file.
 * @returns the parsed key, or null when the text is not a usable public key.
 */
export function parseSshPublicKey(value: unknown): SshPublicKey | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // A multi-line blob would smuggle a second authorized_keys entry.
  if (!text || /[\r\n]/u.test(text)) return null;
  const parts = text.split(/\s+/u);
  if (parts.length < 2) return null;
  const [type, base64] = parts;
  if (!SSH_KEY_TYPES.has(type)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64) || base64.length < 32 || base64.length > 4096) return null;
  const comment = parts.slice(2).join(' ').slice(0, 128);
  return { type, base64, comment, text: `${type} ${base64}` };
}

/**
 * OpenSSH-style SHA256 fingerprint of a public key.
 * @param publicKey parsed key or its raw text.
 * @returns `SHA256:...` without the base64 padding OpenSSH omits.
 */
export function sshKeyFingerprint(publicKey: SshPublicKey | string): string {
  const parsed = typeof publicKey === 'string' ? parseSshPublicKey(publicKey) : publicKey;
  const base64 = parsed?.base64 ?? '';
  if (!base64) return '';
  const digest = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/u, '')}`;
}

/**
 * Build one authorized_keys line for a member.
 * @param options key text, optional source-address restriction, and tag.
 * @returns a single line without the trailing newline.
 */
export function formatAuthorizedKeyLine(options: {
  key: SshPublicKey | string;
  from?: string | null;
  tag?: string | null;
  comment?: string | null;
}): string {
  const parsed = typeof options.key === 'string' ? parseSshPublicKey(options.key) : options.key;
  if (!parsed) throw new Error('Unexpected SSH public key format.');
  const comment = (options.comment ?? '').replace(/[\r\n]/gu, ' ').trim().slice(0, 100);
  const tag = options.tag ? `${AUTHORIZED_KEY_TAG_PREFIX}${options.tag}` : '';
  const suffix = tag || comment ? ` ${[tag, comment].filter(Boolean).join(' ')}` : '';
  // `from=` pins the key to the member's VPN address, so a leaked key still
  // only works from that member's tunnel address.
  const from = options.from ? `from="${options.from.replace(/["\\]/gu, '')}" ` : '';
  return `${from}${parsed.text}${suffix}`;
}

/**
 * Whether an authorized_keys line carries the given managed tag.
 * @param line one file line.
 * @param tag tag without the `dsh-mesh:` prefix.
 * @returns true when the line belongs to that peer.
 */
export function authorizedKeyHasTag(line: string, tag: string): boolean {
  const token = `${AUTHORIZED_KEY_TAG_PREFIX}${tag}`;
  const fields = line.trim().split(/\s+/u);
  // Fields are [options] type base64 [comment...]; skip the key material.
  return fields.length > 2 && fields.slice(2).includes(token);
}

/**
 * Remove every managed line tagged with `tag`.
 * @param text current authorized_keys contents.
 * @param tag tag without the `dsh-mesh:` prefix.
 * @returns remaining text, with a trailing newline when non-empty.
 */
export function removeAuthorizedKeyTag(text: string, tag: string): string {
  const kept = String(text ?? '')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '' && !authorizedKeyHasTag(line, tag));
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/**
 * Insert or replace the managed line for one peer.
 * @param text current authorized_keys contents.
 * @param entry line produced by {@link formatAuthorizedKeyLine}.
 * @param tag tag without the `dsh-mesh:` prefix.
 * @returns new file contents, always ending with a newline.
 */
export function upsertAuthorizedKey(text: string, entry: string, tag: string): string {
  const kept = removeAuthorizedKeyTag(text, tag);
  return `${kept}${entry.trim()}\n`;
}

/**
 * The Host stanza that makes `ssh dsh-gateway` and `ssh <vpnIp>` work without
 * extra flags. `~` is resolved by the member's ssh client, not by us.
 * @param options gateway address, login user, and port.
 * @returns the managed block including its marker lines.
 */
export function gatewaySshConfigBlock(options: { host: string; user: string; port?: number }): string {
  const host = options.host.trim();
  const user = options.user.trim();
  const port = Number.isSafeInteger(options.port) && (options.port as number) > 0 ? Number(options.port) : 22;
  return [
    `# >>> ${GATEWAY_BLOCK_NAME} >>>`,
    `Host dsh-gateway ${host}`,
    `  HostName ${host}`,
    `  User ${user}`,
    `  Port ${port}`,
    `  IdentityFile ~/.ssh/${MEMBER_KEY_NAME}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    `# <<< ${GATEWAY_BLOCK_NAME} <<<`,
  ].join('\n');
}

/**
 * Replace one marker-delimited block, keeping everything the user wrote.
 * @param text current config contents.
 * @param name block name between the markers.
 * @param block block body, with or without its marker lines.
 * @returns new config contents ending with a newline.
 */
export function mergeManagedBlock(text: string, name: string, block: string): string {
  const begin = `# >>> ${name} >>>`;
  const end = `# <<< ${name} <<<`;
  const lines = String(text ?? '').split(/\r?\n/u);
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === begin) {
      inside = true;
      continue;
    }
    if (inside) {
      if (line.trim() === end) inside = false;
      continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const body = block.includes(begin) ? block : `${begin}\n${block}\n${end}`;
  return `${[...kept, ...body.split(/\r?\n/u)].join('\n')}\n`;
}

/** known_hosts address form: `host` on port 22, `[host]:port` otherwise. */
export function knownHostsTarget(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/**
 * Replace the known_hosts entries of one address.
 * @param text current known_hosts contents.
 * @param host address the member connects to.
 * @param port SSH port.
 * @param keys host keys as `type base64` lines.
 * @returns new known_hosts contents.
 */
export function mergeKnownHosts(text: string, host: string, port: number, keys: readonly string[]): string {
  const target = knownHostsTarget(host, port);
  const kept = String(text ?? '')
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const first = trimmed.split(/\s+/u)[0];
      return first !== target && first !== host;
    });
  const entries = keys
    .map((key) => parseSshPublicKey(key))
    .filter((key): key is SshPublicKey => key !== null)
    .map((key) => `${target} ${key.text}`);
  if (entries.length === 0) return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
  return `${[...kept, ...entries].join('\n')}\n`;
}

/**
 * Base64 helpers used by the bootstrap scripts, which cannot parse JSON arrays
 * without adding a dependency: the service ships pre-rendered text instead.
 * @param text UTF-8 text.
 * @returns base64 of the UTF-8 bytes.
 */
export function encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
