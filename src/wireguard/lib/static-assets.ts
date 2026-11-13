/** Shared static-asset lookup for `gate/assets/<name>`. */

import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WireGuardError } from './errors';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const CONTENT_TYPES = new Map([
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.msi', 'application/x-msi'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.tgz', 'application/gzip'],
  ['.tar', 'application/x-tar'],
  ['.deb', 'application/vnd.debian.binary-package'],
  ['.rpm', 'application/x-rpm'],
]);

export interface StaticAsset {
  os: string;
  arch: string;
  kind: string;
  file: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface StaticAssetManifest {
  format: 1;
  name: string;
  version: string;
  generatedAt: string | null;
  assets: StaticAsset[];
}

export interface StaticAssetFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  contentType: string;
}

/** Find the package's `gate/assets` directory from source or bundle. */
function findAssetRoot(): string {
  const configured = String(process.env.DSH_MESH_ASSET_ROOT ?? '').trim();
  if (configured !== '') return configured;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '../gate/assets'),
    path.join(here, '../../gate/assets'),
    path.join(here, '../../../gate/assets'),
    path.join(here, '../../../code/gate/assets'),
    path.join(here, '../../../../code/gate/assets'),
    path.join(process.cwd(), 'gate/assets'),
    path.join(process.cwd(), 'code/gate/assets'),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'wireguard', 'manifest.json'))
      || existsSync(path.join(candidate, 'openssh', 'manifest.json'))
      || existsSync(path.join(candidate, 'hysteria2', 'manifest.json'))) {
      return candidate;
    }
  }
  return candidates[0];
}

/** Pick a content type for one file. */
function contentTypeFor(file: string, fallback: unknown): string {
  if (typeof fallback === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(fallback)) return fallback;
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
}

/** Normalize one manifest, dropping entries without a verifiable digest. */
function normalizeManifest(raw: unknown, folder: string): StaticAssetManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WireGuardError('asset_manifest_invalid', `Asset manifest ${folder} is not a JSON object.`, { status: 503 });
  }
  const value = raw as Record<string, unknown>;
  const legacy = !Array.isArray(value.assets) && typeof value.file === 'string';
  const entries = legacy
    ? [{ os: 'windows', arch: 'x64', file: value.file, sha256: value.sha256, bytes: value.bytes }]
    : value.assets;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new WireGuardError('asset_manifest_invalid', `Asset manifest ${folder} has no assets.`, { status: 503 });
  }
  const assets: StaticAsset[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const file = typeof item.file === 'string' ? item.file : '';
    const sha256 = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : '';
    const bytes = Number(item.bytes);
    if (!FILE_PATTERN.test(file) || !SHA256_PATTERN.test(sha256)) continue;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
    assets.push({
      os: typeof item.os === 'string' ? item.os : '',
      arch: typeof item.arch === 'string' ? item.arch : '',
      kind: typeof item.kind === 'string' ? item.kind : 'file',
      file,
      sha256,
      bytes,
      contentType: contentTypeFor(file, item.contentType),
    });
  }
  if (assets.length === 0) {
    throw new WireGuardError('asset_manifest_invalid', `Asset manifest ${folder} has no usable assets.`, { status: 503 });
  }
  return {
    format: 1,
    name: typeof value.name === 'string' && NAME_PATTERN.test(value.name) ? value.name : folder,
    version: typeof value.version === 'string' && value.version.trim() !== '' ? value.version.trim() : 'unknown',
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : null,
    assets,
  };
}

/** Local static assets under one directory. */
export class AssetStore {
  readonly root: string;

  constructor(root = findAssetRoot()) {
    this.root = root;
  }

  /** Directory for a valid asset name. */
  #directory(name: string): string {
    if (!NAME_PATTERN.test(name)) {
      throw new WireGuardError('asset_name_invalid', `Invalid asset name: ${name}`, { status: 400 });
    }
    return path.join(this.root, name);
  }

  /** Read one normalized manifest and its directory. */
  async #read(folder: string): Promise<StaticAssetManifest & { directory: string }> {
    const directory = this.#directory(folder);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    } catch (error) {
      throw new WireGuardError('asset_manifest_missing', `Cannot read the ${folder} asset manifest.`, {
        status: 503,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
    return { ...normalizeManifest(raw, folder), directory };
  }

  /** Every valid asset, newest build order independent. */
  async index(): Promise<Array<{ name: string; version: string; manifest: string; assets: StaticAsset[] }>> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const result: Array<{ name: string; version: string; manifest: string; assets: StaticAsset[] }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = await this.#read(entry.name);
        result.push({
          name: manifest.name,
          version: manifest.version,
          manifest: `/assets/${encodeURIComponent(manifest.name)}`,
          assets: manifest.assets,
        });
      } catch {
        // A broken optional asset must not hide the others.
      }
    }
    result.sort((left, right) => left.name.localeCompare(right.name));
    return result;
  }

  /** One manifest without the internal directory. */
  async manifest(name: string): Promise<StaticAssetManifest> {
    const { directory: _directory, ...manifest } = await this.#read(name);
    return manifest;
  }

  /** First asset for an OS/arch pair. */
  async first(name: string, os = '', arch = ''): Promise<StaticAsset> {
    const manifest = await this.manifest(name);
    const asset = manifest.assets.find(item => (os === '' || item.os === os) && (arch === '' || item.arch === arch));
    if (asset === undefined) {
      throw new WireGuardError('asset_not_found', `No ${os || 'any'}/${arch || 'any'} file for ${name}.`, { status: 404 });
    }
    return asset;
  }

  /** Resolve one file and verify its size against the manifest. */
  async file(name: string, file: string): Promise<StaticAssetFile> {
    if (!FILE_PATTERN.test(file)) {
      throw new WireGuardError('asset_file_invalid', `Invalid asset file: ${file}`, { status: 400 });
    }
    const manifest = await this.#read(name);
    const asset = manifest.assets.find(item => item.file === file);
    if (asset === undefined) {
      throw new WireGuardError('asset_not_found', `Unknown file for ${name}: ${file}`, { status: 404 });
    }
    const target = path.join(manifest.directory, asset.file);
    const info = await stat(target).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new WireGuardError('asset_missing', `Asset file is missing: ${asset.file}`, { status: 503 });
    }
    if (info.size !== asset.bytes) {
      throw new WireGuardError('asset_size_mismatch', `Asset size mismatch: ${asset.file}`, { status: 503 });
    }
    return {
      path: target,
      name: asset.file,
      size: asset.bytes,
      sha256: asset.sha256,
      contentType: asset.contentType,
    };
  }
}
