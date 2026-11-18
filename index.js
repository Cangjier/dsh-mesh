// src/index.ts
import { homedir as homedir4 } from "node:os";
import path24 from "node:path";

// src/lib/service.mjs
import { mkdir as mkdir11, readFile as readFile13, readdir as readdir7, rm as rm12, stat as stat11, writeFile as writeFile11 } from "node:fs/promises";
import { existsSync as existsSync11, readFileSync as readFileSync4, realpathSync as realpathSync2 } from "node:fs";
import { spawn as spawn6 } from "node:child_process";
import { createHash as createHash7 } from "node:crypto";
import os8 from "node:os";
import path18 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// code/shared/wireguard.mjs
import { readFile as readFile2 } from "node:fs/promises";
import { isIP as isIP2 } from "node:net";
import os from "node:os";
import path2 from "node:path";

// code/shared/geo.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
var DEFAULT_GEO_PROVIDER = "https://ipwho.is/{ip}?fields=success,country,country_code";
var DEFAULT_TIMEOUT_MS = 2500;
var DEFAULT_TTL_MS = 30 * 24 * 60 * 6e4;
var DEFAULT_FAILURE_TTL_MS = 10 * 6e4;
function endpointAddress(endpoint) {
  if (typeof endpoint !== "string") return "";
  const text = endpoint.trim();
  if (text === "") return "";
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) return "";
    const inner = text.slice(1, end);
    return isIP(inner) > 0 ? inner : "";
  }
  if (isIP(text) > 0) return text;
  const colon = text.lastIndexOf(":");
  if (colon <= 0) return "";
  const host = text.slice(0, colon);
  return isIP(host) === 4 ? host : "";
}
function isPrivateAddress(address) {
  if (address === "127.0.0.1" || address === "::1" || address === "::") return true;
  const lower = address.toLowerCase();
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("ff")) return true;
  if (lower.startsWith("2001:db8:")) return true;
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  if (octets[0] >= 224) return true;
  return false;
}
var GeoLookup = class {
  /**
   * @param {object} [options] lookup options.
   * @param {string|null} [options.cacheFile] JSON cache path; null disables persistence.
   * @param {string} [options.provider] URL template containing `{ip}`.
   * @param {typeof fetch} [options.fetchImpl] fetch implementation (tests).
   * @param {number} [options.timeoutMs] per-request budget.
   * @param {number} [options.ttlMs] successful lookup lifetime.
   * @param {number} [options.failureTtlMs] failed lookup lifetime.
   * @param {boolean} [options.enabled] false turns every lookup into a miss.
   * @param {() => number} [options.now] clock (tests).
   * @param {(line: string) => void} [options.log] logger.
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.cacheFile = typeof options.cacheFile === "string" && options.cacheFile !== "" ? options.cacheFile : null;
    this.provider = typeof options.provider === "string" && options.provider.includes("{ip}") ? options.provider : DEFAULT_GEO_PROVIDER;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
    this.failureTtlMs = Number.isFinite(options.failureTtlMs) && options.failureTtlMs > 0 ? options.failureTtlMs : DEFAULT_FAILURE_TTL_MS;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.log = typeof options.log === "function" ? options.log : () => {
    };
    this.cache = /* @__PURE__ */ new Map();
    this.inflight = /* @__PURE__ */ new Map();
    this.loaded = null;
    this.saving = Promise.resolve();
  }
  /**
   * Country for one public address, from cache or the provider.
   * @param {unknown} ip bare IP address.
   * @returns {Promise<{countryCode: string, country: string}|null>} country or null.
   */
  async country(ip) {
    if (!this.enabled || typeof ip !== "string") return null;
    const address = ip.trim();
    if (isIP(address) === 0 || isPrivateAddress(address)) return null;
    await this.#load();
    const cached = this.cache.get(address);
    if (cached !== void 0) {
      const ttl = cached.ok ? this.ttlMs : this.failureTtlMs;
      if (this.now() - cached.at < ttl) {
        return cached.ok ? { countryCode: cached.countryCode, country: cached.country } : null;
      }
    }
    const running = this.inflight.get(address);
    if (running !== void 0) return running;
    const promise = this.#lookup(address).finally(() => {
      this.inflight.delete(address);
    });
    this.inflight.set(address, promise);
    return promise;
  }
  /**
   * Attach `countryCode` / `country` to every member that has a public IP.
   *
   * Mutates the member objects the discovery snapshot is built from, so the
   * panel receives the country on the same row it renders. A failed lookup is
   * not an error: the fields simply stay absent.
   * @template {object} T member shape.
   * @param {T[]} members member rows.
   * @returns {Promise<T[]>} the same rows.
   */
  async enrich(members) {
    if (!this.enabled) return members;
    await Promise.all(members.map(async (member) => {
      const ip = typeof member?.publicIp === "string" ? member.publicIp : "";
      if (ip === "") return;
      try {
        const found = await this.country(ip);
        if (found === null) return;
        member.countryCode = found.countryCode;
        member.country = found.country;
      } catch {
      }
    }));
    return members;
  }
  /**
   * Wait for the pending cache write to finish.
   * @returns {Promise<void>} when the cache is on disk.
   */
  async flush() {
    await this.saving;
  }
  /**
   * Load the persisted cache once.
   * @returns {Promise<void>} when loaded.
   */
  async #load() {
    if (this.loaded !== null) return this.loaded;
    this.loaded = (async () => {
      if (this.cacheFile === null) return;
      try {
        const parsed = JSON.parse(await readFile(this.cacheFile, "utf8"));
        if (parsed === null || typeof parsed !== "object") return;
        for (const [address, entry] of Object.entries(parsed)) {
          if (entry === null || typeof entry !== "object") continue;
          const at = Number(entry.at);
          const countryCode = typeof entry.countryCode === "string" ? entry.countryCode.toUpperCase() : "";
          const country = typeof entry.country === "string" ? entry.country : "";
          if (!Number.isFinite(at) || !/^[A-Z]{2}$/u.test(countryCode)) continue;
          this.cache.set(address, { ok: true, countryCode, country, at });
        }
      } catch {
      }
    })();
    return this.loaded;
  }
  /**
   * Ask the provider once and cache the answer.
   * @param {string} address public IP address.
   * @returns {Promise<{countryCode: string, country: string}|null>} country or null.
   */
  async #lookup(address) {
    const url = this.provider.replaceAll("{ip}", encodeURIComponent(address));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`geo provider answered ${String(response.status)}`);
      const payload = await response.json();
      const countryCode = typeof payload?.country_code === "string" ? payload.country_code.trim().toUpperCase() : "";
      const country = typeof payload?.country === "string" ? payload.country.trim() : "";
      if (payload?.success === false || !/^[A-Z]{2}$/u.test(countryCode)) {
        throw new Error("geo provider returned no country code");
      }
      this.cache.set(address, { ok: true, countryCode, country, at: this.now() });
      void this.#persist();
      return { countryCode, country };
    } catch (error) {
      this.cache.set(address, { ok: false, countryCode: "", country: "", at: this.now() });
      void this.#persist();
      this.log(`country lookup for ${address} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Persist the cache without blocking the caller.
   * @returns {Promise<void>} when written.
   */
  #persist() {
    if (this.cacheFile === null) return Promise.resolve();
    const snapshot = Object.fromEntries(this.cache);
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(path.dirname(this.cacheFile), { recursive: true });
        await writeFile(this.cacheFile, `${JSON.stringify(snapshot, null, 2)}
`, "utf8");
      } catch {
      }
    });
    return this.saving;
  }
};

// code/shared/wireguard.mjs
var DEFAULT_MEMBER_PORTS = Object.freeze([80, 8080]);
var MEMBER_SERVICE = "dsh-mesh";
function dshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim();
  return configured && configured.length > 0 ? configured : path2.join(os.homedir(), ".dsh");
}
async function readWireGuardState(options = {}) {
  const file = options.file ?? path2.join(options.home ?? dshHome(), "wireguard", "state.json");
  try {
    const text = await readFile2(file, "utf8");
    const state = JSON.parse(text);
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      return { path: file, state: null, error: "wireguard state.json is not an object" };
    }
    return { path: file, state, error: null };
  } catch (error) {
    return {
      path: file,
      state: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
function normalizeAddress(value) {
  if (typeof value !== "string") return "";
  let text = value.trim();
  if (text.startsWith("[") && text.includes("]")) text = text.slice(1, text.indexOf("]"));
  if (text.toLowerCase().startsWith("::ffff:")) text = text.slice(7);
  const zone = text.indexOf("%");
  if (zone > 0) text = text.slice(0, zone);
  return isIP2(text) > 0 ? text : "";
}
function wireGuardIdentity(state) {
  const source = state !== null && typeof state === "object" ? state : {};
  const settings = source.settings !== null && typeof source.settings === "object" ? source.settings : {};
  const server = source.server !== null && typeof source.server === "object" ? source.server : {};
  const client = source.client !== null && typeof source.client === "object" ? source.client : {};
  const role = source.role === "server" ? "server" : "client";
  const vpnCidr = typeof settings.vpnCidr === "string" && settings.vpnCidr !== "" ? settings.vpnCidr : typeof server.vpnCidr === "string" && server.vpnCidr !== "" ? server.vpnCidr : typeof client.vpnCidr === "string" && client.vpnCidr !== "" ? client.vpnCidr : "10.66.66.0/24";
  const serverIp = normalizeAddress(settings.serverIp) || normalizeAddress(server.serverIp) || "10.66.66.1";
  const selfIp = role === "server" ? normalizeAddress(serverIp) || normalizeAddress(server.endpointHost) || "" : normalizeAddress(client.assignedIp);
  const selfName = String(
    role === "server" ? server.hostname ?? os.hostname() : client.name ?? os.hostname()
  );
  const serverUrl = String(client.serverUrl ?? server.controlUrl ?? "").replace(/\/+$/u, "");
  const joinCode = String(
    client.joinCode ?? settings.joinCode ?? server.joinCode ?? ""
  );
  const connected = role === "server" ? server.running === true : client.connected === true;
  const warnings = Array.isArray(role === "server" ? server.warnings : client.warnings) ? (role === "server" ? server.warnings : client.warnings).filter((value) => typeof value === "string") : [];
  return {
    role,
    vpnCidr,
    serverIp,
    serverUrl,
    joinCode,
    selfIp,
    selfName,
    connected,
    lastHandshakeAt: typeof client.lastHandshakeAt === "string" ? client.lastHandshakeAt : null,
    warnings
  };
}
function normalizePeer(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const peer = (
    /** @type {Record<string, unknown>} */
    value
  );
  const ip = normalizeAddress(peer.ip);
  if (ip === "") return null;
  const endpoint = typeof peer.endpoint === "string" && peer.endpoint.trim() !== "" ? peer.endpoint.trim() : null;
  return {
    name: typeof peer.name === "string" && peer.name.trim() !== "" ? peer.name.trim() : `peer-${ip}`,
    ip,
    online: peer.online !== false,
    lastHandshakeAt: typeof peer.lastHandshakeAt === "string" ? peer.lastHandshakeAt : null,
    endpoint,
    publicIp: endpointAddress(endpoint)
  };
}
async function fetchServerControlPeers(state, options, timeoutMs, fetchImpl) {
  const settings = state?.settings !== null && typeof state?.settings === "object" ? state.settings : {};
  const server = state?.server !== null && typeof state?.server === "object" ? state.server : {};
  const rawPort = settings.controlPort ?? server.controlPort;
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 0;
  if (port === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${String(port)}/api/dsh-wireguard/state`, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const peers = payload?.state?.server?.peers ?? payload?.server?.peers;
    if (!Array.isArray(peers)) return null;
    return peers.map(normalizePeer).filter((peer) => peer !== null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchPeers(state, options = {}) {
  const identity = wireGuardIdentity(state);
  const timeoutMs = options.timeoutMs ?? 3e3;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (identity.role === "server") {
    const live = await fetchServerControlPeers(state, options, timeoutMs, fetchImpl);
    if (live !== null) return { peers: live, source: "server-control-panel", error: null };
    const raw = state?.server?.peers;
    if (!Array.isArray(raw)) {
      return { peers: [], source: "server-state", error: "wireguard server state has no peer list" };
    }
    const peers = raw.map(normalizePeer).filter((peer) => peer !== null);
    return { peers, source: "server-state", error: null };
  }
  if (identity.serverUrl === "" || identity.joinCode === "") {
    return {
      peers: [],
      source: "client-control-panel",
      error: "wireguard client state has no control-panel URL or join code"
    };
  }
  const endpoint = new URL("/peers", `${identity.serverUrl}/`);
  endpoint.searchParams.set("code", identity.joinCode);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        return {
          peers: [],
          source: "client-control-panel",
          error: `wireguard control panel answered ${String(response.status)}`
        };
      }
      const payload = await response.json();
      const raw = payload !== null && typeof payload === "object" ? payload.peers : null;
      if (!Array.isArray(raw)) {
        return { peers: [], source: "client-control-panel", error: "wireguard control panel returned no peer list" };
      }
      const peers = raw.map(normalizePeer).filter((peer) => peer !== null);
      return { peers, source: "client-control-panel", error: null };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      peers: [],
      source: "client-control-panel",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function probeMember(ip, options = {}) {
  const address = normalizeAddress(ip);
  if (address === "") {
    return { ok: false, port: null, info: null, latencyMs: 0, error: "not an IP address" };
  }
  const ports = [...new Set((options.ports ?? DEFAULT_MEMBER_PORTS).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
  const timeoutMs = options.timeoutMs ?? 2500;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError = "no member port answered";
  for (const port of ports) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(new URL(`http://${formatHost(address)}:${String(port)}/__gate/member`), {
          headers: { accept: "application/json" },
          signal: controller.signal
        });
        if (!response.ok) {
          lastError = `member endpoint answered ${String(response.status)} on port ${String(port)}`;
          continue;
        }
        const info = await response.json();
        if (info === null || typeof info !== "object" || info.service !== MEMBER_SERVICE) {
          lastError = `port ${String(port)} is HTTP but not ${MEMBER_SERVICE}`;
          continue;
        }
        return { ok: true, port, info, latencyMs: Date.now() - started, error: null };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, port: null, info: null, latencyMs: 0, error: lastError };
}
function formatHost(address) {
  return isIP2(address) === 6 ? `[${address}]` : address;
}
async function discoverMembers(options) {
  const state = options.state ?? null;
  const identity = wireGuardIdentity(state);
  const ports = [.../* @__PURE__ */ new Set([...options.ports ?? [], ...DEFAULT_MEMBER_PORTS])];
  const peerResult = state === null ? { peers: [], source: "none", error: options.stateError ?? "wireguard state.json is unavailable" } : await fetchPeers(state, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl });
  const peers = peerResult.peers.filter((peer) => identity.selfIp === "" || peer.ip !== identity.selfIp);
  if (identity.role === "client" && identity.serverIp !== "" && !peers.some((peer) => peer.ip === identity.serverIp)) {
    peers.unshift({
      name: "wireguard-server",
      ip: identity.serverIp,
      online: true,
      lastHandshakeAt: null
    });
  }
  const probes = await Promise.all(peers.map(async (peer) => ({
    peer,
    probe: await probeMember(peer.ip, {
      ports,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl
    })
  })));
  const members = probes.map(({ peer, probe }) => ({
    id: peer.ip,
    kind: "peer",
    name: peer.name,
    ip: peer.ip,
    online: peer.online,
    lastHandshakeAt: peer.lastHandshakeAt,
    // The peer's public WireGuard endpoint is the only reliable "where is
    // this machine" signal the gateway has without SSH-ing into it.
    endpoint: peer.endpoint ?? null,
    publicIp: peer.publicIp ?? "",
    dsh: probe.ok,
    port: probe.port,
    latencyMs: probe.latencyMs,
    gate: probe.info,
    system: probe.info?.system ?? null,
    error: probe.error
  }));
  if (options.geoLookup !== void 0 && options.geoLookup !== null) {
    await options.geoLookup.enrich(members).catch(() => {
    });
  }
  const self = {
    id: "local",
    kind: "self",
    name: options.self?.name ?? identity.selfName ?? os.hostname(),
    ip: options.self?.ip ?? identity.selfIp ?? "",
    online: options.self?.online ?? true,
    lastHandshakeAt: options.self?.lastHandshakeAt ?? identity.lastHandshakeAt,
    dsh: options.self?.dsh ?? true,
    port: options.self?.port ?? null,
    latencyMs: 0,
    gate: options.self?.gate ?? null,
    system: options.self?.system ?? null,
    endpoint: options.self?.endpoint ?? null,
    publicIp: options.self?.publicIp ?? "",
    error: options.self?.error ?? null
  };
  const warnings = [];
  if (state === null) warnings.push(peerResult.error ?? "wireguard state.json is unavailable");
  else if (peerResult.error !== null) warnings.push(peerResult.error);
  if (identity.role === "client" && !identity.connected) warnings.push("the WireGuard client reports it is not connected");
  if (identity.role === "server" && !identity.connected) warnings.push("the WireGuard server reports it is not running");
  return {
    ok: true,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: {
      role: identity.role,
      vpnCidr: identity.vpnCidr,
      serverIp: identity.serverIp,
      serverUrl: identity.serverUrl,
      peerSource: peerResult.source
    },
    self,
    members,
    warnings
  };
}

// code/shared/deployment.mjs
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path3 from "node:path";
function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function readDeployment(packageRoot) {
  const root = path3.resolve(packageRoot);
  let resolved = root;
  let layout = "flat";
  const current = path3.join(root, "current");
  if (existsSync(current)) {
    try {
      resolved = realpathSync(current);
      layout = "bluegreen";
    } catch {
    }
  } else if (path3.basename(path3.dirname(root)) === "releases") {
    layout = "bluegreen";
  }
  const manifest = readJson(path3.join(resolved, "manifest.json"));
  const plugin = manifest === null ? readJson(path3.join(resolved, "plugins", "dsh-mesh", "package.json")) : null;
  const manifestVersion = typeof manifest?.version === "string" && manifest.version.trim() !== "" ? manifest.version.trim() : null;
  const pluginVersion = typeof plugin?.version === "string" && plugin.version.trim() !== "" ? plugin.version.trim() : null;
  return {
    version: manifestVersion ?? pluginVersion,
    buildStamp: typeof manifest?.buildStamp === "string" && manifest.buildStamp.trim() !== "" ? manifest.buildStamp.trim() : null,
    builtAt: typeof manifest?.builtAt === "string" && manifest.builtAt.trim() !== "" ? manifest.builtAt.trim() : null,
    // The release id only means something for blue-green installs; the flat
    // gateway's directory name is the operator's choice, not a version.
    release: layout === "bluegreen" ? path3.basename(resolved) : null,
    layout,
    target: manifest?.target !== null && typeof manifest?.target === "object" ? manifest.target : null
  };
}

// code/build/job.mjs
import { appendFile as appendFile2, mkdir as mkdir8, readFile as readFile9, rename as rename5, rm as rm8, stat as stat6, writeFile as writeFile7 } from "node:fs/promises";
import { existsSync as existsSync6 } from "node:fs";
import { randomBytes } from "node:crypto";
import os6 from "node:os";
import path12 from "node:path";

// code/build/engine.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync as existsSync3 } from "node:fs";
import { chmod, cp, mkdir as mkdir2, open, readFile as readFile4, readdir as readdir2, rename, rm, stat, writeFile as writeFile2 } from "node:fs/promises";
import { Readable as Readable2 } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import os2 from "node:os";
import path5 from "node:path";

// code/build/static-assets.mjs
import { existsSync as existsSync2 } from "node:fs";
import { readFile as readFile3, readdir } from "node:fs/promises";
import path4 from "node:path";
var NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
var FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
var SHA256_PATTERN = /^[0-9a-f]{64}$/u;
async function collectStaticAssets(gateDirectory) {
  const assetsDirectory = path4.join(gateDirectory, "assets");
  if (!existsSync2(assetsDirectory)) return [];
  const directories = await readdir(assetsDirectory, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      const manifestPath = path4.join(assetsDirectory, directory.name, "manifest.json");
      const raw = JSON.parse(await readFile3(manifestPath, "utf8"));
      const entries = Array.isArray(raw.assets) ? raw.assets : typeof raw.file === "string" ? [{ os: "windows", arch: "x64", file: raw.file, sha256: raw.sha256, bytes: raw.bytes }] : [];
      const assets = [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const file = typeof entry.file === "string" ? entry.file : "";
        const sha256 = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : "";
        const bytes = Number(entry.bytes);
        if (!FILE_PATTERN.test(file) || !SHA256_PATTERN.test(sha256)) continue;
        if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
        if (!existsSync2(path4.join(assetsDirectory, directory.name, file))) continue;
        assets.push({
          os: typeof entry.os === "string" ? entry.os : "",
          arch: typeof entry.arch === "string" ? entry.arch : "",
          kind: typeof entry.kind === "string" ? entry.kind : "file",
          file,
          sha256,
          bytes
        });
      }
      if (assets.length === 0) continue;
      const name = typeof raw.name === "string" && NAME_PATTERN.test(raw.name) ? raw.name : directory.name;
      result.push({
        name,
        version: typeof raw.version === "string" ? raw.version : "unknown",
        manifest: `gate/assets/${directory.name}/manifest.json`,
        assets
      });
    } catch {
    }
  }
  result.sort((left, right) => left.name.localeCompare(right.name));
  return result;
}

// code/build/proxy.mjs
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { Readable } from "node:stream";
var MAX_REDIRECTS = 10;
function parseProxyUrl(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") throw new Error("proxy URL is empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`proxy is not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`proxy must be http or https, got ${url.protocol}`);
  }
  if (url.hostname === "") throw new Error(`proxy has no host: ${value}`);
  const port = url.port === "" ? url.protocol === "https:" ? 443 : 80 : Number.parseInt(url.port, 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error(`proxy has no valid port: ${value}`);
  const auth = url.username === "" ? null : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return { href: `${url.protocol}//${url.host}`, protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/gu, ""), port, auth };
}
function proxyEnv(proxyUrl, base = process.env) {
  const proxy2 = parseProxyUrl(proxyUrl);
  const noProxy = ["localhost", "127.0.0.1", "::1", "10.66.66.0/24", "*.local", base.NO_PROXY, base.no_proxy].filter((value) => typeof value === "string" && value !== "").join(",");
  return {
    ...base,
    HTTP_PROXY: proxy2.href,
    HTTPS_PROXY: proxy2.href,
    ALL_PROXY: proxy2.href,
    http_proxy: proxy2.href,
    https_proxy: proxy2.href,
    all_proxy: proxy2.href,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // npm and pnpm read configuration from npm_config_* environment variables;
    // they do not honour HTTPS_PROXY on their own.
    npm_config_proxy: proxy2.href,
    npm_config_https_proxy: proxy2.href,
    npm_config_noproxy: noProxy
  };
}
function connectTunnel(proxy2, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const authority = `${host}:${String(port)}`;
    const request = (proxy2.protocol === "https:" ? https : http).request({
      host: proxy2.hostname,
      port: proxy2.port,
      method: "CONNECT",
      path: authority,
      headers: {
        host: authority,
        ...proxy2.auth === null ? {} : { "proxy-authorization": `Basic ${Buffer.from(proxy2.auth).toString("base64")}` }
      },
      timeout: timeoutMs
    });
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT ${authority}: HTTP ${String(response.statusCode)}`));
        return;
      }
      socket.setTimeout(0);
      resolve({ socket, status: response.statusCode });
    });
    request.once("timeout", () => request.destroy(new Error(`proxy CONNECT ${authority} timed out`)));
    request.once("error", reject);
    request.end();
  });
}
function requestOnce(href, options) {
  const target = new URL(href);
  const httpsTarget = target.protocol === "https:";
  const port = target.port === "" ? httpsTarget ? 443 : 80 : Number.parseInt(target.port, 10);
  const headers = { host: target.host, ...options.headers };
  if (!httpsTarget) {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({
        host: options.proxy.hostname,
        port: options.proxy.port,
        method: options.method,
        path: target.href,
        headers: {
          ...headers,
          ...options.proxy.auth === null ? {} : { "proxy-authorization": `Basic ${Buffer.from(options.proxy.auth).toString("base64")}` }
        },
        timeout: options.timeoutMs
      }, (response) => resolve(toResponse(response)));
      outgoing.once("timeout", () => outgoing.destroy(new Error(`proxy request to ${href} timed out`)));
      outgoing.once("error", reject);
      outgoing.end();
    });
  }
  return new Promise((resolve, reject) => {
    connectTunnel(options.proxy, target.hostname, port, options.timeoutMs).then(({ socket }) => {
      const secure = tls.connect({ socket, servername: target.hostname });
      secure.once("error", reject);
      secure.once("secureConnect", () => {
        const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
        agent.createConnection = (_options, callback) => {
          callback(null, secure);
          return secure;
        };
        const outgoing = https.request({
          host: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          method: options.method,
          headers,
          agent,
          timeout: options.timeoutMs
        }, (response) => {
          response.once("end", () => agent.destroy());
          resolve(toResponse(response));
        });
        outgoing.once("timeout", () => outgoing.destroy(new Error(`proxy request to ${href} timed out`)));
        outgoing.once("error", reject);
        outgoing.end();
      });
    }).catch(reject);
  });
}
function toResponse(response) {
  const headers = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== void 0) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  const status = response.statusCode ?? 0;
  let webBody;
  return {
    get body() {
      webBody ??= Readable.toWeb(response);
      return webBody;
    },
    ok: status >= 200 && status < 300,
    status,
    statusText: response.statusMessage ?? "",
    headers: {
      get: (name) => headers[String(name).toLowerCase()] ?? null,
      has: (name) => Object.hasOwn(headers, String(name).toLowerCase()),
      forEach: (callback) => {
        for (const [name, value] of Object.entries(headers)) callback(value, name);
      }
    },
    async text() {
      const chunks = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    async arrayBuffer() {
      const chunks = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      const buffer = Buffer.concat(chunks);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  };
}
async function drain(response) {
  try {
    await response.text();
  } catch {
  }
}
function createProxyFetch(proxyUrl, options = {}) {
  const proxy2 = parseProxyUrl(proxyUrl);
  return async function proxiedFetch(input, init = {}) {
    let href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let method = init.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method ?? "GET");
    const headers = {};
    const rawHeaders = init.headers ?? (typeof input === "object" && !(input instanceof URL) ? input.headers : void 0);
    if (rawHeaders !== void 0) {
      if (typeof rawHeaders.forEach === "function" && !Array.isArray(rawHeaders)) {
        rawHeaders.forEach((value, name) => {
          headers[String(name).toLowerCase()] = String(value);
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [name, value] of rawHeaders) headers[String(name).toLowerCase()] = String(value);
      } else {
        for (const [name, value] of Object.entries(rawHeaders)) headers[String(name).toLowerCase()] = String(value);
      }
    }
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await requestOnce(href, { proxy: proxy2, method, headers, timeoutMs: options.timeoutMs ?? 6e4 });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null) return response;
      await drain(response);
      href = new URL(location, href).href;
      if (response.status === 303) method = "GET";
    }
    throw new Error(`too many redirects for ${href}`);
  };
}

// code/build/engine.mjs
var DEFAULT_SOURCE = "https://github.com/deepseek-ai/deepseek-harness";
var DEFAULT_REF = "master";
var DEFAULT_TARGETS = Object.freeze(["linux-x64", "win-x64"]);
function proxyFor(options = {}) {
  const proxy2 = typeof options.proxy === "string" && options.proxy.trim() !== "" ? options.proxy.trim() : null;
  if (proxy2 === null) return { fetchImpl: options.fetchImpl, env: options.env, proxy: null };
  return {
    fetchImpl: options.fetchImpl ?? createProxyFetch(proxy2),
    env: proxyEnv(proxy2, options.env ?? process.env),
    proxy: proxy2
  };
}
async function sha256File(file) {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}
function parseTarget(target) {
  const [os9, arch] = String(target).split("-");
  if (!["linux", "win", "darwin"].includes(os9)) throw new Error(`unsupported target OS: ${target}`);
  if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported target architecture: ${target}`);
  return { os: os9, arch, libc: os9 === "linux" ? "glibc" : "" };
}
function classifySource(source) {
  const value = String(source).trim().replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");
  if (existsSync3(value)) return { kind: "local", dir: path5.resolve(value) };
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`source is neither a local directory nor a URL: ${source}`);
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error(`source must be a github.com repository or a local directory: ${source}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`cannot read owner/repository from ${source}`);
  return { kind: "github", owner: parts[0], repo: parts[1] };
}
function tarballUrls(repo, ref) {
  const base = `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz`;
  if (/^[0-9a-f]{40}$/iu.test(ref)) return [`${base}/${ref}`];
  return [`${base}/refs/heads/${encodeURIComponent(ref)}`, `${base}/refs/tags/${encodeURIComponent(ref)}`];
}
async function remoteRevision(source, ref, options = {}) {
  let classified;
  try {
    classified = classifySource(source);
  } catch {
    return null;
  }
  if (classified.kind !== "github") return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15e3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const url of tarballUrls(classified, ref)) {
      try {
        const response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
        if (response.status === 404) continue;
        if (!response.ok) return null;
        const etag = typeof response.headers?.get === "function" ? response.headers.get("etag") : null;
        if (typeof etag === "string" && etag.trim() !== "") return etag.replace(/^W\//u, "").replaceAll('"', "").trim();
        return null;
      } catch {
        return null;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function download(url, file, options = {}) {
  if (existsSync3(file) && (await stat(file)).size > 0) return true;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {
  });
  log(`GET ${url}`);
  const response = await fetchImpl(url, { redirect: "follow" });
  if (response.status === 404) return false;
  if (!response.ok || response.body === null) throw new Error(`download failed: ${url} -> HTTP ${String(response.status)}`);
  await mkdir2(path5.dirname(file), { recursive: true });
  const temporary = `${file}.part`;
  await pipeline(Readable2.fromWeb(response.body), createWriteStream(temporary));
  await rename(temporary, file);
  return true;
}
function runCommand(command, args, options = {}) {
  const log = options.log ?? (() => {
  });
  const tail = [];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: options.shell === true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ ok: false, code: null, signal: null, tail, error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line === "") continue;
        tail.push(line);
        if (tail.length > 240) tail.shift();
        log(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let timer;
    if (options.timeoutMs !== void 0 && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        log(`timed out after ${String(options.timeoutMs)}ms; terminating ${command}`);
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5e3).unref();
      }, options.timeoutMs);
      timer.unref();
    }
    child.on("error", (error) => {
      if (timer !== void 0) clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, tail, error });
    });
    child.on("close", (code, signal) => {
      if (timer !== void 0) clearTimeout(timer);
      resolve({ ok: code === 0, code, signal, tail });
    });
  });
}
async function extractTarball(archive, destination, options = {}) {
  await rm(destination, { recursive: true, force: true });
  await mkdir2(destination, { recursive: true });
  if (archive.toLowerCase().endsWith(".zip") && process.platform !== "win32") {
    const temporary = `${destination}.zip-tmp`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir2(temporary, { recursive: true });
    const unzipped = await runCommand("unzip", ["-q", archive, "-d", temporary], { log: options.log });
    if (!unzipped.ok) {
      throw new Error(`cannot extract ${archive}: ${unzipped.error?.message ?? `unzip exited with ${String(unzipped.code)}`}
${unzipped.tail.join("\n")}`);
    }
    const entries = await readdir2(temporary);
    const first = entries[0];
    const wrapped = entries.length === 1 && first !== void 0 && (await stat(path5.join(temporary, first))).isDirectory();
    const content = wrapped ? path5.join(temporary, first) : temporary;
    await rm(destination, { recursive: true, force: true });
    await cp(content, destination, { recursive: true });
    await rm(temporary, { recursive: true, force: true });
    return;
  }
  const result = await runCommand("tar", ["-xf", archive, "--strip-components=1", "-C", destination], {
    log: options.log
  });
  if (!result.ok) {
    throw new Error(`cannot extract ${archive}: ${result.error?.message ?? `tar exited with ${String(result.code)}`}
${result.tail.join("\n")}`);
  }
}
async function prepareSource(options) {
  const source = options.source ?? DEFAULT_SOURCE;
  const ref = options.ref ?? DEFAULT_REF;
  const log = options.log ?? (() => {
  });
  const classified = classifySource(source);
  if (classified.kind === "local") {
    log(`using local source ${classified.dir}`);
    return { dir: classified.dir, source, ref, local: true };
  }
  const cacheDir = options.cacheDir ?? path5.join(os2.homedir(), ".dsh", "mesh", "cache");
  const urls = tarballUrls(classified, ref);
  const archive = path5.join(cacheDir, "sources", `${sha256Text(`${classified.owner}/${classified.repo}@${ref}`).slice(0, 16)}.tar.gz`);
  const etagFile = `${archive}.etag`;
  const immutable = /^[0-9a-f]{40}$/iu.test(ref);
  const remoteEtag = immutable ? null : await remoteRevision(source, ref, { fetchImpl: options.fetchImpl, log });
  let cachedEtag = "";
  if (!immutable && existsSync3(etagFile)) {
    try {
      cachedEtag = (await readFile4(etagFile, "utf8")).trim();
    } catch {
      cachedEtag = "";
    }
  }
  if (!immutable && existsSync3(archive)) {
    const age = Date.now() - (await stat(archive)).mtimeMs;
    const staleContent = remoteEtag !== null && cachedEtag !== remoteEtag;
    if (staleContent || age > (options.maxCacheAgeMs ?? 6 * 60 * 6e4)) {
      log(staleContent ? `refreshing cached tarball for ${ref} (remote content changed)` : `refreshing cached tarball for ${ref} (older than the cache window)`);
      await rm(archive, { force: true });
    }
  }
  let downloaded = false;
  for (const url of urls) {
    downloaded = await download(url, archive, { fetchImpl: options.fetchImpl, log });
    if (downloaded) break;
  }
  if (!downloaded) throw new Error(`cannot find ref "${ref}" in ${classified.owner}/${classified.repo}`);
  if (remoteEtag !== null) {
    try {
      await writeFile2(etagFile, `${remoteEtag}
`, "utf8");
    } catch {
    }
  }
  const archiveSha256 = await sha256File(archive);
  const dir = path5.join(options.workDir, "src");
  log(`extracting ${path5.basename(archive)} to ${dir}`);
  await extractTarball(archive, dir, { log });
  return { dir, source, ref, local: false, archive, archiveSha256, archiveEtag: remoteEtag };
}
async function loadRecipes(file) {
  const parsed = JSON.parse(await readFile4(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.steps)) {
    throw new Error(`${file} is not a recipe manifest`);
  }
  return parsed;
}
async function applyRecipes(options) {
  const log = options.log ?? (() => {
  });
  const applied = [];
  const skipped2 = [];
  const mismatches = [];
  for (const step of options.recipes.steps) {
    for (const entry of step.files ?? []) {
      const target = path5.join(options.dir, entry.path);
      const overlay = path5.join(options.overlayRoot, entry.overlay);
      const label = { step: step.id, title: step.title, doc: step.doc, path: entry.path };
      if (!existsSync3(overlay)) {
        mismatches.push({ ...label, reason: "overlay file is missing", expected: entry.baseSha256 ?? null, actual: null });
        continue;
      }
      let current = null;
      try {
        current = await readFile4(target, "utf8");
      } catch (error) {
        if (entry.baseSha256 !== null) {
          mismatches.push({ ...label, reason: "upstream file is missing", expected: entry.baseSha256, actual: null });
          continue;
        }
      }
      if (current !== null && current.includes(entry.marker)) {
        skipped2.push(label);
        continue;
      }
      if (entry.baseSha256 === null) {
        if (current !== null) {
          mismatches.push({ ...label, reason: "new file already exists without the overlay marker", expected: null, actual: sha256Text(current) });
          continue;
        }
      } else {
        const actual = current === null ? null : sha256Text(current);
        if (actual !== entry.baseSha256) {
          mismatches.push({ ...label, reason: "upstream file changed since the overlay was recorded", expected: entry.baseSha256, actual });
          continue;
        }
      }
      await mkdir2(path5.dirname(target), { recursive: true });
      await cp(overlay, target);
      const written = await readFile4(target, "utf8");
      if (!written.includes(entry.marker)) {
        mismatches.push({ ...label, reason: "overlay was written but its marker is missing", expected: entry.baseSha256 ?? null, actual: sha256Text(written) });
        continue;
      }
      applied.push(label);
      log(`applied ${step.id}: ${entry.path}`);
    }
  }
  return { ok: mismatches.length === 0, applied, skipped: skipped2, mismatches };
}
async function writeWorkOrder(options) {
  await mkdir2(options.dir, { recursive: true });
  const jobDir = options.jobDir ?? options.dir;
  const jsonPath = path5.join(options.dir, "work-order.json");
  const markdownPath = path5.join(options.dir, "work-order.md");
  const promptPath = path5.join(options.dir, "subagent-prompt.txt");
  const prompt = [
    `\u4F60\u5728\u4E3A dsh-mesh \u6784\u5EFA ${options.source}@${options.ref} \u7684\u4FEE\u6539\u7248 Web \u5305\u3002`,
    "\u786E\u5B9A\u6027\u6784\u5EFA\u5728\u5E94\u7528\u6E90\u7801\u8986\u76D6\u5C42\u65F6\u5931\u8D25\u3002\u8BF7\u53EA\u4FEE\u590D\u5DE5\u4F5C\u6811\u91CC\u7684\u6E90\u7801\uFF0C\u4E0D\u8981\u653E\u5BBD\u8986\u76D6\u5C42\u6821\u9A8C\u3002",
    "\u5148\u8BFB work-order.md \u4E0E\u5BF9\u5E94\u7684 Step \u6587\u6863\uFF0C\u518D\u4FEE\u6539\u4E0B\u5217\u6587\u4EF6\uFF0C\u4F7F\u6BCF\u4E2A\u6587\u4EF6\u7684\u8986\u76D6\u5C42 marker \u5B58\u5728\uFF0C\u5E76\u8BA9 pnpm run build:web \u901A\u8FC7\u3002",
    `\u4FEE\u5B8C\u540E\u8C03\u7528 dsh-mesh \u7684 build \u5DE5\u5177\uFF0C\u5E76\u4F20 jobId="${path5.basename(jobDir)}"\uFF1B\u5B83\u4F1A\u81EA\u52A8\u628A\u4FEE\u6539\u56FA\u5316\u6210\u8986\u76D6\u5C42\u5E76\u7EE7\u7EED\u540C\u4E00\u4E2A job\u3002`,
    "",
    ...options.result.mismatches.map((item) => `- ${item.path}\uFF08${item.step}\uFF1B${item.doc}\uFF09\uFF1A${item.reason}`)
  ].join("\n");
  const markdown = [
    `# \u6784\u5EFA\u5DE5\u4F5C\u5355\uFF1A${options.source}@${options.ref}`,
    "",
    `- \u6E90\u7801\u6811\uFF1A\`${options.worktree ?? path5.join(jobDir, "src")}\``,
    `- \u4EFB\u52A1\u76EE\u5F55\uFF1A\`${jobDir}\``,
    `- \u751F\u6210\u65F6\u95F4\uFF1A${(/* @__PURE__ */ new Date()).toISOString()}`,
    `- \u5931\u8D25\u9879\uFF1A${String(options.result.mismatches.length)}`,
    "",
    "## \u5931\u8D25\u9879",
    "",
    "| Step | \u6587\u4EF6 | \u671F\u671B base SHA-256 | \u5B9E\u9645 SHA-256 | \u539F\u56E0 | \u6587\u6863 |",
    "|---|---|---|---|---|---|",
    ...options.result.mismatches.map((item) => `| ${item.step} | \`${item.path}\` | ${item.expected ?? "\u2014"} | ${item.actual ?? "\u2014"} | ${item.reason} | \`${item.doc}\` |`),
    "",
    "## \u4FEE\u590D\u65B9\u5F0F",
    "",
    "1. \u6253\u5F00\u6E90\u7801\u6811\u91CC\u7684\u76EE\u6807\u6587\u4EF6\uFF0C\u6309\u5BF9\u5E94 Step \u6587\u6863\u628A\u754C\u9762\u6539\u597D\u3002",
    "2. \u4FDD\u6301\u8986\u76D6\u5C42 marker \u6CE8\u91CA\u5B58\u5728\uFF1Apicker \u662F `dsh-mesh overlay: picker`\uFF0Clogin \u662F `dsh-mesh overlay: login`\u3002",
    `3. \u8C03\u7528 build \u5DE5\u5177\uFF0C\u53C2\u6570 \`jobId="${path5.basename(jobDir)}"\`\uFF1B\u5B83\u4F1A\u628A\u6539\u597D\u7684\u6587\u4EF6\u5199\u56DE \`build/overlays/\`\u3002`,
    "4. \u540C\u4E00\u6B21 build \u8C03\u7528\u4F1A\u590D\u7528\u5DE5\u4F5C\u6811\u7EE7\u7EED install/build/package\uFF1B\u4E0B\u4E00\u6B21\u540C\u4E00 ref \u4F1A\u76F4\u63A5\u5E94\u7528\u65B0\u8986\u76D6\u5C42\u3002",
    "",
    "## \u5EFA\u8BAE\u7684\u5B50\u4EE3\u7406\u63D0\u793A\u8BCD",
    "",
    "```text",
    prompt,
    "```"
  ].join("\n");
  await writeFile2(jsonPath, JSON.stringify({
    source: options.source,
    ref: options.ref,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    jobDir,
    worktree: options.worktree ?? path5.join(jobDir, "src"),
    mismatches: options.result.mismatches
  }, null, 2), "utf8");
  await writeFile2(markdownPath, markdown, "utf8");
  await writeFile2(promptPath, prompt, "utf8");
  return { json: jsonPath, markdown: markdownPath, prompt: promptPath };
}
async function learnOverlays(options) {
  const learned = [];
  const actualByPath = new Map(
    (options.mismatches ?? []).filter((item) => typeof item.actual === "string" && /^[0-9a-f]{64}$/u.test(item.actual)).map((item) => [item.path, item.actual])
  );
  for (const step of options.recipes.steps) {
    for (const entry of step.files ?? []) {
      const source = path5.join(options.worktree, entry.path);
      let text;
      try {
        text = await readFile4(source, "utf8");
      } catch {
        throw new Error(`cannot learn ${entry.path}: the file is missing from the worktree`);
      }
      if (!text.includes(entry.marker)) {
        throw new Error(`cannot learn ${entry.path}: the overlay marker "${entry.marker}" is missing`);
      }
      const target = path5.join(options.overlayRoot, entry.overlay);
      await mkdir2(path5.dirname(target), { recursive: true });
      await writeFile2(target, text, "utf8");
      const actual = actualByPath.get(entry.path);
      if (actual !== void 0 && entry.baseSha256 !== null) entry.baseSha256 = actual;
      learned.push({ step: step.id, path: entry.path, overlay: entry.overlay });
    }
  }
  return { ok: true, learned, recipes: options.recipes };
}
function needsShell(command) {
  return process.platform === "win32" && /^(pnpm|npm|npx|yarn|corepack)(\.cmd)?$/iu.test(command);
}
async function buildWebWorkerPackages(options) {
  const log = options.log ?? (() => {
  });
  const built = [];
  for (const name of ["@deepseek-ai/dsh-experimental-webworker-runtime", "@deepseek-ai/dsh-experimental-webworker-packer"]) {
    const packageDir = path5.join(options.dir, "packages", "experimental", name.replace("@deepseek-ai/dsh-experimental-", ""));
    if (!existsSync3(packageDir)) {
      log(`skipping ${name}: not in this revision`);
      continue;
    }
    log(`$ pnpm --filter ${name} exec tsdown`);
    const result = await runCommand("pnpm", ["--filter", name, "exec", "tsdown"], {
      cwd: options.dir,
      log,
      env: options.env,
      shell: needsShell("pnpm"),
      timeoutMs: 10 * 6e4
    });
    if (!result.ok) {
      return { ok: false, built, error: `building ${name} failed (exit ${String(result.code)})
${result.tail.join("\n")}` };
    }
    built.push(name);
  }
  return { ok: true, built };
}
async function runWebBuild(options) {
  const log = options.log ?? (() => {
  });
  const progress = async (phase, percent) => {
    await options.onProgress?.({ phase, percent });
  };
  const install = options.install === void 0 ? ["pnpm", "install", "--frozen-lockfile"] : options.install;
  const build = options.build ?? ["pnpm", "run", "build:web"];
  if (install !== null && install.length > 0) {
    await progress("build", 16);
    log(`$ ${install.join(" ")}`);
    const installed = await runCommand(install[0], install.slice(1), {
      cwd: options.dir,
      log,
      env: options.env,
      shell: needsShell(install[0]),
      timeoutMs: 30 * 6e4
    });
    if (!installed.ok) {
      return { ok: false, dist: null, error: `dependency installation failed (exit ${String(installed.code)})
${installed.tail.join("\n")}` };
    }
    await progress("build", 40);
  }
  const prepareCommands = options.prepare ?? [];
  if (options.prebuild !== false && prepareCommands.length === 0) {
    const prepared = await buildWebWorkerPackages({ dir: options.dir, log, env: options.env });
    if (!prepared.ok) return { ok: false, dist: null, error: prepared.error ?? "webworker prebuild failed" };
  }
  for (const command of prepareCommands) {
    if (command.length === 0) continue;
    log(`$ ${command.join(" ")}`);
    const prepared = await runCommand(command[0], command.slice(1), {
      cwd: options.dir,
      log,
      env: options.env,
      shell: needsShell(command[0]),
      timeoutMs: 60 * 6e4
    });
    if (!prepared.ok) {
      return { ok: false, dist: null, error: `prepare step failed (exit ${String(prepared.code)}): ${command.join(" ")}
${prepared.tail.join("\n")}` };
    }
  }
  await progress("build", 50);
  log(`$ ${build.join(" ")}`);
  const built = await runCommand(build[0], build.slice(1), {
    cwd: options.dir,
    log,
    env: options.env,
    shell: needsShell(build[0]),
    timeoutMs: 30 * 6e4
  });
  if (!built.ok) {
    return { ok: false, dist: null, error: `web build failed (exit ${String(built.code)})
${built.tail.join("\n")}` };
  }
  await progress("build", 62);
  const candidates = [
    path5.join(options.dir, "apps", "web", "dist"),
    path5.join(options.dir, "dist")
  ];
  for (const candidate of candidates) {
    if (existsSync3(path5.join(candidate, "index.html"))) return { ok: true, dist: candidate };
  }
  return { ok: false, dist: null, error: "the build finished but no dist/index.html was found" };
}
async function copyIfExists(from, to) {
  if (!existsSync3(from)) return;
  await mkdir2(path5.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}
async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir2(current, { withFileTypes: true })) {
      const full = path5.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path5.relative(dir, full));
    }
  }
  if (existsSync3(dir)) await walk(dir);
  return out;
}
var PLUGIN_FINGERPRINT_FILES = [
  "package.json",
  "index.js",
  "client.js",
  "cordis.patch.yml",
  "icon.svg",
  "VERSION",
  "start-dsh.sh",
  "start-interop.sh",
  "install-interop-service.sh",
  "uninstall-interop-service.sh",
  "install.sh",
  "start.sh",
  "stop.sh",
  "status.sh",
  "doctor.sh",
  "install.ps1",
  "start.ps1",
  "stop.ps1",
  "start.cmd",
  "stop.cmd",
  "start-stack.ps1"
];
var PLUGIN_FINGERPRINT_DIRS = ["locale", "build", "docs", "code"];
async function pluginFingerprint(repositoryRoot) {
  const files = [];
  for (const name of PLUGIN_FINGERPRINT_FILES) {
    if (existsSync3(path5.join(repositoryRoot, name))) files.push(name);
  }
  for (const dir of PLUGIN_FINGERPRINT_DIRS) {
    for (const rel of await listFiles(path5.join(repositoryRoot, dir))) files.push(path5.join(dir, rel));
  }
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await sha256File(path5.join(repositoryRoot, rel)));
    hash.update("\n");
  }
  return hash.digest("hex");
}
async function readExtraPlugins(repositoryRoot) {
  const file = path5.join(repositoryRoot, "build", "plugins.json");
  if (!existsSync3(file)) return [];
  const parsed = JSON.parse(await readFile4(file, "utf8"));
  const list = parsed !== null && typeof parsed === "object" && Array.isArray(parsed.plugins) ? parsed.plugins : [];
  return list.filter((entry) => entry !== null && typeof entry === "object").map((entry) => ({
    name: typeof entry.name === "string" ? entry.name.trim() : "",
    dir: typeof entry.dir === "string" && entry.dir.trim() !== "" ? entry.dir.trim() : "",
    repo: typeof entry.repo === "string" ? entry.repo.trim() : "",
    ref: typeof entry.ref === "string" && entry.ref.trim() !== "" ? entry.ref.trim() : "main"
  })).filter((entry) => entry.name !== "" && entry.repo !== "").map((entry) => ({ ...entry, dir: entry.dir !== "" ? entry.dir : path5.join("plugins", entry.name) }));
}
async function copyExtraPlugins(options) {
  const plugins = await readExtraPlugins(options.repositoryRoot);
  if (plugins.length === 0) return [];
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const log = options.log ?? (() => {
  });
  const records = [];
  for (const plugin of plugins) {
    const classified = classifySource(plugin.repo);
    if (classified.kind !== "github") {
      throw new Error(`extra plugin ${plugin.name} must be a github.com repository, not ${plugin.repo}`);
    }
    const archive = path5.join(cacheDir, "plugins", `${plugin.name}.tar.gz`);
    await mkdir2(path5.dirname(archive), { recursive: true });
    await rm(archive, { force: true });
    let downloaded = false;
    for (const url of tarballUrls(classified, plugin.ref)) {
      downloaded = await download(url, archive, { fetchImpl: options.fetchImpl, log });
      if (downloaded) break;
    }
    if (!downloaded) {
      throw new Error(`cannot download extra plugin ${plugin.name} from ${plugin.repo}@${plugin.ref}`);
    }
    const tree = path5.join(cacheDir, "plugins", `${plugin.name}-tree`);
    await rm(tree, { recursive: true, force: true });
    await extractTarball(archive, tree, { log });
    const target = path5.join(options.packageDir, plugin.dir);
    await rm(target, { recursive: true, force: true });
    await mkdir2(path5.dirname(target), { recursive: true });
    await cp(tree, target, { recursive: true });
    await rm(tree, { recursive: true, force: true });
    records.push({
      name: plugin.name,
      dir: plugin.dir,
      repo: plugin.repo,
      ref: plugin.ref,
      archiveSha256: await sha256File(archive),
      archiveEtag: await remoteRevision(plugin.repo, plugin.ref, { fetchImpl: options.fetchImpl, log })
    });
    log(`extra plugin ${plugin.name}@${plugin.ref} -> ${plugin.dir}`);
  }
  return records;
}
async function assembleWebPackage(options) {
  const { os: targetOs2, arch, libc } = parseTarget(options.target);
  const buildStamp = typeof options.buildStamp === "string" && options.buildStamp !== "" ? options.buildStamp : null;
  const identity = buildStamp === null ? options.version : `${options.version}-${buildStamp}`;
  const packageDir = path5.join(options.outputDir, `dsh-mesh-${identity}-${targetOs2}-${arch}`);
  await rm(packageDir, { recursive: true, force: true });
  await mkdir2(path5.join(packageDir, "web"), { recursive: true });
  await cp(options.dist, path5.join(packageDir, "web"), { recursive: true });
  await copyIfExists(path5.join(options.repositoryRoot, "code", "gate"), path5.join(packageDir, "gate"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "shared"), path5.join(packageDir, "shared"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "shared"), path5.join(packageDir, "code", "shared"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "config"), path5.join(packageDir, "config"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "windows-service"), path5.join(packageDir, "code", "windows-service"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "interop-service"), path5.join(packageDir, "code", "interop-service"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "wireguard"), path5.join(packageDir, "code", "wireguard"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "dsh-service"), path5.join(packageDir, "code", "dsh-service"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "deploy"), path5.join(packageDir, "code", "deploy"));
  await copyIfExists(path5.join(options.repositoryRoot, "docs"), path5.join(packageDir, "docs"));
  for (const file of ["install.sh", "start.sh", "stop.sh", "status.sh", "doctor.sh", "install.ps1", "start.ps1", "stop.ps1", "start.cmd", "stop.cmd", "start-stack.ps1", "VERSION"]) {
    await copyIfExists(path5.join(options.repositoryRoot, "code", file), path5.join(packageDir, file));
  }
  for (const file of ["start-dsh.sh", "start-interop.sh", "install-interop-service.sh", "uninstall-interop-service.sh"]) {
    await copyIfExists(path5.join(options.repositoryRoot, file), path5.join(packageDir, file));
  }
  for (const file of ["index.js", "client.js", "cordis.patch.yml", "package.json"]) {
    await copyIfExists(path5.join(options.repositoryRoot, file), path5.join(packageDir, "plugins", "dsh-mesh", file));
  }
  await copyIfExists(path5.join(options.repositoryRoot, "locale"), path5.join(packageDir, "plugins", "dsh-mesh", "locale"));
  await copyIfExists(path5.join(options.repositoryRoot, "build"), path5.join(packageDir, "plugins", "dsh-mesh", "build"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "build"), path5.join(packageDir, "plugins", "dsh-mesh", "code", "build"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "shared"), path5.join(packageDir, "plugins", "dsh-mesh", "code", "shared"));
  await copyIfExists(path5.join(options.repositoryRoot, "code", "deploy"), path5.join(packageDir, "plugins", "dsh-mesh", "code", "deploy"));
  const extraPlugins = await copyExtraPlugins({
    packageDir,
    repositoryRoot: options.repositoryRoot,
    cacheDir: options.cacheDir,
    fetchImpl: options.fetchImpl,
    log: options.log
  });
  const staticAssets = await collectStaticAssets(path5.join(options.repositoryRoot, "code", "gate"));
  const manifest = {
    format: 1,
    name: "dsh-mesh",
    // Capabilities a rollback can inspect without executing the package. The
    // embedded interop moved the :8765 listener into DSH Web; a rollback to a
    // release without this feature has to start the standalone unit again.
    features: ["embedded-interop"],
    // `version` is the DSH version, unchanged. `buildStamp` is the daily
    // build revision that appears after it in the archive name.
    version: options.version,
    buildStamp,
    target: { os: targetOs2, arch, libc },
    builtAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: options.source ?? null,
    ref: options.ref ?? null,
    tree: options.tree ?? null,
    sourceEtag: options.sourceEtag ?? null,
    plugin: {
      version: options.pluginVersion ?? null,
      fingerprint: options.pluginFingerprint ?? null
    },
    files: (await listFiles(packageDir)).length,
    staticAssets,
    extraPlugins
  };
  await writeFile2(path5.join(packageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { packageDir, manifest };
}
async function fixTarExecutableModes(archive) {
  const raw = gunzipSync(await readFile4(archive));
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const type = String.fromCharCode(header[156] || 0);
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    if (type === "0" || type === "\0" || type === "5" || type === "2") {
      header.write("0000755\0", 100, 8, "ascii");
    }
    header.fill(32, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    offset += 512 + (Number.isFinite(size) ? Math.ceil(size / 512) * 512 : 0);
  }
  await writeFile2(archive, gzipSync(raw, { level: 9 }));
}
async function archivePackage(packageDir, target, options = {}) {
  const { os: targetOs2 } = parseTarget(target);
  const archive = targetOs2 === "win" ? `${packageDir}.zip` : `${packageDir}.tar.gz`;
  await rm(archive, { force: true });
  let result;
  if (targetOs2 === "win" && process.platform !== "win32") {
    result = await runCommand("zip", ["-qr", archive, path5.basename(packageDir)], {
      cwd: path5.dirname(packageDir),
      log: options.log
    });
  } else {
    const args = targetOs2 === "win" ? ["-a", "-c", "-f", archive, "-C", path5.dirname(packageDir), path5.basename(packageDir)] : ["-czf", archive, "-C", path5.dirname(packageDir), path5.basename(packageDir)];
    result = await runCommand("tar", args, { log: options.log });
  }
  if (!result.ok) throw new Error(`cannot archive ${packageDir}: ${result.tail.join("\n")}`);
  if (targetOs2 !== "win" && process.platform === "win32") await fixTarExecutableModes(archive);
  return archive;
}
function nodeArchiveName(version, target) {
  if (target.os === "win") return `node-v${version}-win-${target.arch}.zip`;
  return `node-v${version}-${target.os === "darwin" ? "darwin" : "linux"}-${target.arch}.tar.gz`;
}
async function installNodeRuntime(options) {
  const parsed = parseTarget(options.target);
  const log = options.log ?? (() => {
  });
  const archiveName = nodeArchiveName(options.version, parsed);
  const base = `https://nodejs.org/dist/v${options.version}`;
  const archive = path5.join(options.cacheDir, "node", archiveName);
  const downloaded = await download(`${base}/${archiveName}`, archive, { fetchImpl: options.fetchImpl, log });
  if (!downloaded) throw new Error(`Node ${options.version} has no ${parsed.os}-${parsed.arch} archive`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sums = await fetchImpl(`${base}/SHASUMS256.txt`, { redirect: "follow" });
  if (!sums.ok) throw new Error(`cannot read Node SHASUMS256.txt: HTTP ${String(sums.status)}`);
  const text = await sums.text();
  const line = text.split(/\r?\n/u).find((entry) => entry.endsWith(` ${archiveName}`));
  if (line === void 0) throw new Error(`Node SHASUMS256.txt has no entry for ${archiveName}`);
  const expected = line.split(/\s+/u)[0];
  const actual = await sha256File(archive);
  if (actual !== expected) throw new Error(`Node archive checksum mismatch for ${archiveName}`);
  await extractTarball(archive, options.destination, { log });
  if (parsed.os === "win") {
    if (!existsSync3(path5.join(options.destination, "node.exe"))) throw new Error("Node archive did not contain node.exe");
  } else {
    const node = path5.join(options.destination, "bin", "node");
    if (!existsSync3(node)) throw new Error("Node archive did not contain bin/node");
    await chmod(node, 493);
  }
  return { directory: options.destination, archive, sha256: actual };
}
async function installAppDependencies(options) {
  const parsed = parseTarget(options.target);
  const log = options.log ?? (() => {
  });
  await mkdir2(options.appDir, { recursive: true });
  await writeFile2(path5.join(options.appDir, "package.json"), JSON.stringify({
    name: "dsh-web-offline",
    private: true,
    version: "1.0.0"
  }, null, 2), "utf8");
  const args = [
    "install",
    `@deepseek-ai/dsh@${options.version}`,
    `--os=${parsed.os === "win" ? "win32" : parsed.os}`,
    `--cpu=${parsed.arch}`,
    ...parsed.libc === "" ? [] : [`--libc=${parsed.libc}`],
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund"
  ];
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  log(`$ npm ${args.join(" ")}`);
  const result = await runCommand(command, args, {
    cwd: options.appDir,
    log,
    env: options.env,
    shell: process.platform === "win32",
    timeoutMs: 45 * 6e4
  });
  if (!result.ok) {
    throw new Error(`npm install @deepseek-ai/dsh@${options.version} failed (exit ${String(result.code)})
${result.tail.join("\n")}`);
  }
  return { appDir: options.appDir, nodeModules: path5.join(options.appDir, "node_modules") };
}
async function overlayFrontend(options) {
  const log = options.log ?? (() => {
  });
  const frontend = path5.join(options.appDir, "node_modules", "@deepseek-ai", "dsh-web-frontend");
  const packageFile = path5.join(frontend, "package.json");
  if (!existsSync3(packageFile)) {
    throw new Error(`cannot find @deepseek-ai/dsh-web-frontend under ${options.appDir}`);
  }
  const target = path5.join(frontend, "dist");
  await rm(target, { recursive: true, force: true });
  await cp(options.dist, target, { recursive: true });
  if (!existsSync3(path5.join(target, "index.html"))) {
    throw new Error("the built web frontend has no index.html after the copy");
  }
  log(`frontend installed at ${target}`);
  return target;
}
async function inspectShellSeedTable(distDir) {
  const index = path5.join(distDir, "index.html");
  if (!existsSync3(index)) return null;
  const html = await readFile4(index, "utf8");
  const sources = [...html.matchAll(/<script[^>]+src="\.?\/?([^"]+\.js)"/gu)].map((match) => match[1]);
  for (const relative of sources) {
    const file = path5.join(distDir, relative);
    if (!existsSync3(file)) continue;
    const text = await readFile4(file, "utf8");
    const call = /staticModules:([A-Za-z_$][\w$]*)\(\)/u.exec(text);
    if (call === null) continue;
    const name = call[1];
    const array = new RegExp(`function ${name}\\(\\)\\{return Object\\.values\\(`, "u").test(text);
    const record = new RegExp(`function ${name}\\(\\)\\{return\\{`, "u").test(text);
    return {
      file,
      name,
      shape: array ? "array" : record ? "record" : "unknown",
      hasRankByName: text.includes("rankByName")
    };
  }
  return null;
}
async function inspectAppModuleLoader(appDir) {
  const root = path5.join(appDir, "node_modules", "@deepseek-ai", "dsh-client-modules");
  const file = path5.join(root, "lib", "client.js");
  if (!existsSync3(file)) return null;
  const text = await readFile4(file, "utf8");
  let version = null;
  try {
    version = JSON.parse(await readFile4(path5.join(root, "package.json"), "utf8")).version ?? null;
  } catch {
    version = null;
  }
  return {
    file,
    version,
    recordOnly: /new Map\(Object\.entries\(options\.staticModules\)/u.test(text),
    arrayAware: /Array\.isArray\(options\.staticModules\)/u.test(text) || /options\.staticModules\.map\(/u.test(text),
    // A recovery patch (data/seed-patch on an affected install) adds the
    // missing export to the loader itself; the shell then does not need it.
    providesRankByName: text.includes("rankByName")
  };
}
async function findClientBundleUsing(appDir, exportName) {
  const scope = path5.join(appDir, "node_modules", "@deepseek-ai");
  if (!existsSync3(scope)) return null;
  const entries = await readdir2(scope, { withFileTypes: true }).catch(() => []);
  const pattern = new RegExp(`\\.${exportName}\\b`, "u");
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "dsh-client-ui-primitives" || entry.name === "dsh-client-modules") continue;
    const file = path5.join(scope, entry.name, "lib", "client.js");
    if (!existsSync3(file)) continue;
    const text = await readFile4(file, "utf8").catch(() => "");
    if (pattern.test(text)) return entry.name;
  }
  return null;
}
async function checkFrontendAppContract(options) {
  const log = options.log ?? (() => {
  });
  const shell = await inspectShellSeedTable(options.dist);
  if (shell === null) {
    log("frontend/app contract check: the shell static module table was not found; skipped");
    return { shell: null, loader: null };
  }
  const loader = await inspectAppModuleLoader(options.appDir);
  if (loader === null) {
    throw new Error("frontend/app contract check: app/node_modules/@deepseek-ai/dsh-client-modules is missing");
  }
  const version = loader.version === null ? "" : `@${loader.version}`;
  if (shell.shape === "array" && loader.recordOnly && !loader.arrayAware) {
    throw new Error(
      `the built web shell passes staticModules as a descriptor array, but @deepseek-ai/dsh-client-modules${version} in app/ only accepts a record (\`new Map(Object.entries(options.staticModules))\`). The source tree is ahead of the npm DSH app it is packaged with; every client plugin would fail with "Failed to load plugins". Pin --ref to the release commit of this DSH version (or build app/ from the same source tree) and rebuild.`
    );
  }
  if (!shell.hasRankByName && !loader.providesRankByName) {
    const user = await findClientBundleUsing(options.appDir, "rankByName");
    if (user !== null) {
      throw new Error(
        `the installed client plugin ${user} calls rankByName from @deepseek-ai/dsh-client-ui-primitives, but the built web shell's bundled copy does not export it. The source tree and the npm DSH app are from different revisions; pin --ref to the release commit of this DSH version (or build app/ from the same source tree) and rebuild.`
      );
    }
  }
  log(`frontend/app contract check: seed table ${shell.shape}, loader${version} ${loader.recordOnly && !loader.arrayAware ? "record-only" : "array-aware"}`);
  return { shell, loader };
}
async function chooseFrontend(options) {
  const log = options.log ?? (() => {
  });
  try {
    await checkFrontendAppContract({ appDir: options.appDir, dist: options.dist, log });
    return { source: "built", dist: options.dist, reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`source-built frontend is incompatible with app/: ${reason}`);
    const published = path5.join(options.appDir, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist");
    if (!existsSync3(path5.join(published, "index.html"))) throw error;
    log("keeping the published frontend from app/ (its client bundles match by construction); the UI overlays still apply through patchInstalledClient");
    await checkFrontendAppContract({ appDir: options.appDir, dist: published, log });
    return { source: "published", dist: published, reason };
  }
}
async function patchInstalledClient(options) {
  const log = options.log ?? (() => {
  });
  const picker = path5.join(
    options.appDir,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-directory-picker-browse",
    "lib",
    "client.js"
  );
  const login = path5.join(
    options.appDir,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-settings-account",
    "lib",
    "client.js"
  );
  for (const file of [picker, login]) {
    if (!existsSync3(file)) throw new Error(`installed client bundle is missing: ${file}`);
  }
  const steps = [
    { file: picker, script: path5.join(options.repositoryRoot, "code", "gate", "patch-picker.mjs"), marker: "dsh-picker-patched" },
    { file: login, script: path5.join(options.repositoryRoot, "code", "gate", "patch-login.mjs"), marker: "dsh-gate-account-login" }
  ];
  for (const step of steps) {
    log(`patching ${path5.basename(path5.dirname(path5.dirname(step.file)))} client bundle`);
    const result = await runCommand(process.execPath, [step.script, step.file], {
      cwd: options.repositoryRoot,
      log,
      timeoutMs: 12e4
    });
    if (!result.ok) throw new Error(`client bundle patch failed: ${step.script}
${result.tail.join("\n")}`);
    const text = await readFile4(step.file, "utf8");
    if (!text.includes(step.marker)) throw new Error(`client bundle patch did not leave its marker: ${step.file}`);
    await rm(`${step.file}.orig`, { force: true });
  }
  return { picker, login };
}
async function assembleRuntimePackage(options) {
  const log = options.log ?? (() => {
  });
  const { packageDir, manifest } = await assembleWebPackage(options);
  const appDir = path5.join(packageDir, "app");
  await mkdir2(appDir, { recursive: true });
  await installAppDependencies({
    appDir,
    version: options.dshVersion,
    target: options.target,
    env: options.env,
    log
  });
  await patchInstalledClient({ appDir, repositoryRoot: options.repositoryRoot, log });
  const frontend = await chooseFrontend({ appDir, dist: options.dist, log });
  if (frontend.source === "built") {
    await overlayFrontend({ appDir, dist: frontend.dist, log });
  } else {
    const web = path5.join(packageDir, "web");
    await rm(web, { recursive: true, force: true });
    await cp(frontend.dist, web, { recursive: true });
  }
  await installNodeRuntime({
    version: options.nodeVersion,
    target: options.target,
    cacheDir: options.cacheDir,
    destination: path5.join(packageDir, "runtime", "node"),
    fetchImpl: options.fetchImpl,
    log
  });
  for (const file of ["install.ps1", "start.ps1", "stop.ps1", "start.cmd", "stop.cmd", "start-stack.ps1"]) {
    await copyIfExists(path5.join(options.repositoryRoot, "code", file), path5.join(packageDir, file));
  }
  await writeFile2(path5.join(packageDir, ".offline-payload"), "dsh-mesh\n", "utf8");
  await writeFile2(path5.join(packageDir, "VERSION"), `${options.dshVersion}
`, "utf8");
  const updated = {
    ...manifest,
    kind: "offline-runtime",
    dshVersion: options.dshVersion,
    nodeVersion: options.nodeVersion,
    // Which shell this package serves: the freshly built one, or the one that
    // shipped in the app because the two revisions disagreed. `reason` keeps
    // the drift visible on the package instead of only in the build log.
    frontend: frontend.reason === null ? { source: frontend.source } : { source: frontend.source, reason: frontend.reason },
    files: (await listFiles(packageDir)).length
  };
  await writeFile2(path5.join(packageDir, "manifest.json"), JSON.stringify(updated, null, 2), "utf8");
  return { packageDir, manifest: updated };
}

// code/build/smoke.mjs
import { spawn as spawn3 } from "node:child_process";
import { accessSync, constants, existsSync as existsSync5 } from "node:fs";
import { appendFile, copyFile, mkdir as mkdir5, mkdtemp as mkdtemp3, readFile as readFile6, rm as rm5, symlink as symlink2, writeFile as writeFile4 } from "node:fs/promises";
import net from "node:net";
import os4 from "node:os";
import path9 from "node:path";

// code/shared/chrome.mjs
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { mkdtemp, readFile as readFile5, rm as rm2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import path6 from "node:path";
var CdpSocket = class _CdpSocket {
  #socket;
  #nextId = 1;
  #pending = /* @__PURE__ */ new Map();
  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const entry = this.#pending.get(message.id);
      if (entry === void 0) return;
      this.#pending.delete(message.id);
      if (message.error !== void 0) entry.reject(new Error(String(message.error.message ?? "cdp error")));
      else entry.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const entry of this.#pending.values()) entry.reject(new Error("chrome closed the debug socket"));
      this.#pending.clear();
    });
  }
  /** Open one debug socket. */
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        reject(new Error("cannot open the chrome debug socket"));
      }, { once: true });
    });
    return new _CdpSocket(socket);
  }
  /**
   * Send one command.
   * @param method - CDP method name.
   * @param params - method parameters.
   * @returns the protocol result.
   */
  send(method, params = {}) {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.#socket.close();
    } catch {
    }
  }
};
async function waitForFile(file, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync4(file)) return;
    if (signal?.aborted === true) throw new Error(`aborted waiting for ${path6.basename(file)}`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 120);
      timer.unref?.();
    });
  }
  throw new Error(`timed out waiting for ${path6.basename(file)}`);
}
var ChromeSession = class _ChromeSession {
  #child;
  #cdp;
  #browser;
  #profileDir;
  /**
   * Start headless Chrome and attach to one page target.
   * @param binary - Chrome executable path.
   * @param options - viewport size and start directory.
   */
  static async launch(binary, { width = 560, height = 820 } = {}) {
    const session = new _ChromeSession();
    session.#profileDir = await mkdtemp(path6.join(tmpdir(), "dsh-chrome-"));
    session.#child = spawn2(binary, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--window-size=${String(width)},${String(height)}`,
      `--user-data-dir=${session.#profileDir}`,
      "--remote-debugging-port=0",
      "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    session.#child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4e3);
    });
    const portFile = path6.join(session.#profileDir, "DevToolsActivePort");
    const exitedEarly = new Promise((_resolve, reject) => {
      session.#child.once("error", (error) => {
        reject(new Error(`cannot run ${binary}: ${error.message}`));
      });
      session.#child.once("exit", (code, signal) => {
        const detail = stderr.trim() === "" ? "" : `: ${stderr.trim().slice(-300)}`;
        reject(new Error(`exited before writing a debug port (${signal ?? String(code)})${detail}`));
      });
    });
    const waiting = new AbortController();
    try {
      await Promise.race([waitForFile(portFile, 45e3, waiting.signal), exitedEarly]);
    } catch (error) {
      session.kill();
      const reason = error instanceof Error ? error.message : String(error);
      const hint = process.platform === "win32" ? "; on Windows a service running as LocalSystem may not be allowed to start Edge \u2014 run the gate as a regular user or set DSH_GATE_CHROME" : "";
      throw new Error(`chrome did not start: ${reason}${hint}`);
    } finally {
      waiting.abort();
    }
    const [port, wsPath] = (await readFile5(portFile, "utf8")).split("\n");
    if (port === void 0 || wsPath === void 0) throw new Error("chrome wrote no debug port");
    const browser = await CdpSocket.open(`ws://127.0.0.1:${String(port).trim()}${wsPath.trim()}`);
    const created = await browser.send("Target.createTarget", { url: "about:blank" });
    browser.close();
    const listed = await (await fetch(`http://127.0.0.1:${String(port).trim()}/json/list`)).json();
    const target = listed.find((entry) => entry.id === created.targetId);
    if (target === void 0) throw new Error("chrome created no page target");
    session.#cdp = await CdpSocket.open(target.webSocketDebuggerUrl);
    await session.#cdp.send("Page.enable");
    await session.#cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    return session;
  }
  /**
   * Attach to a browser that is already listening on a debugging port, such as
   * one started inside the interactive Windows session.
   * @param port - loopback debugging port.
   * @param options - viewport size.
   */
  static async attach(port, { width = 560, height = 820 } = {}) {
    const session = new _ChromeSession();
    const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`, {
      signal: AbortSignal.timeout(5e3)
    })).json();
    const browser = await CdpSocket.open(String(version.webSocketDebuggerUrl));
    session.#browser = browser;
    const created = await browser.send("Target.createTarget", { url: "about:blank" });
    const listed = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
    const target = listed.find((entry) => entry.id === created.targetId);
    if (target === void 0) throw new Error("the attached browser created no page target");
    session.#cdp = await CdpSocket.open(target.webSocketDebuggerUrl);
    await session.#cdp.send("Page.enable");
    await session.#cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    return session;
  }
  /** Navigate the page and wait for the load event. */
  async goto(url, timeoutMs = 3e4) {
    await this.#cdp.send("Page.navigate", { url });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { result } = await this.#cdp.send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true
      });
      if (result?.value === "complete") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  /**
   * Install one cookie before the first navigation. Used by the build smoke
   * test so a page load does not have to drive the login form.
   * @param name - cookie name.
   * @param value - cookie value.
   * @param url - origin the cookie belongs to.
   * @param options - extra attributes.
   */
  async setCookie(name, value, url, options = {}) {
    const result = await this.#cdp.send("Network.setCookie", {
      name,
      value,
      url,
      path: options.path ?? "/",
      httpOnly: options.httpOnly !== false,
      sameSite: options.sameSite ?? "Lax",
      secure: options.secure === true
    });
    if (result?.success === false) throw new Error(`chrome refused the cookie ${name}`);
  }
  /** Current document URL. */
  async url() {
    const { result } = await this.#cdp.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true
    });
    return String(result?.value ?? "");
  }
  /**
   * Evaluate an expression in the page and return its value.
   * @param expression - an expression evaluating to JSON-serializable data.
   */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.#cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (exceptionDetails !== void 0) {
      throw new Error(String(exceptionDetails.text ?? "page evaluation failed"));
    }
    return result?.value;
  }
  /** A PNG screenshot of the current viewport. */
  async screenshot() {
    const { data } = await this.#cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    return Buffer.from(String(data), "base64");
  }
  /**
   * A PNG capture of one page rectangle, rendered at extra scale so a small
   * element (a QR code) still comes back at print quality.
   * @param box - page rectangle in CSS pixels.
   * @param scale - device pixel multiplier.
   */
  async screenshotClip(box, scale = 3) {
    const { data } = await this.#cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale }
    });
    return Buffer.from(String(data), "base64");
  }
  /** Terminate the browser and drop its profile directory. */
  kill() {
    this.#cdp?.close();
    if (this.#browser !== void 0) {
      const browser = this.#browser;
      browser.send("Browser.close", {}).catch(() => void 0).finally(() => browser.close());
    }
    try {
      this.#child?.kill("SIGKILL");
    } catch {
    }
    if (this.#profileDir !== void 0) {
      rm2(this.#profileDir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
};

// code/build/chrome-download.mjs
import { createWriteStream as createWriteStream3 } from "node:fs";
import { chmod as chmod3, mkdir as mkdir4, mkdtemp as mkdtemp2, readdir as readdir3, rename as rename2, rm as rm4, stat as stat3 } from "node:fs/promises";
import os3 from "node:os";
import path8 from "node:path";
import { Readable as Readable3 } from "node:stream";
import { pipeline as pipeline3 } from "node:stream/promises";

// code/build/zip.mjs
import { createReadStream, createWriteStream as createWriteStream2 } from "node:fs";
import { chmod as chmod2, mkdir as mkdir3, open as open2, rm as rm3, stat as stat2, symlink, writeFile as writeFile3 } from "node:fs/promises";
import path7 from "node:path";
import { pipeline as pipeline2 } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";
var EOCD_SIGNATURE = 101010256;
var CENTRAL_SIGNATURE = 33639248;
var LOCAL_SIGNATURE = 67324752;
var EOCD_SIZE = 22;
var MAX_COMMENT = 65535;
var S_IFMT = 61440;
var S_IFDIR = 16384;
var S_IFLNK = 40960;
function findEndOfCentralDirectory(tail) {
  for (let offset = tail.length - EOCD_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + EOCD_SIZE + commentLength === tail.length) return offset;
  }
  return -1;
}
function safeEntryPath(destination, name) {
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`zip entry has an absolute path: ${name}`);
  }
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new Error(`zip entry escapes the destination: ${name}`);
  const root = path7.resolve(destination);
  const target = path7.resolve(root, ...segments);
  if (target !== root && !target.startsWith(`${root}${path7.sep}`)) {
    throw new Error(`zip entry escapes the destination: ${name}`);
  }
  return target;
}
async function readEntry(handle, offset, compressedSize, method) {
  const compressed = Buffer.alloc(compressedSize);
  await handle.read(compressed, 0, compressedSize, offset);
  if (method === 0) return compressed;
  if (method === 8) return inflateRawSync(compressed);
  throw new Error(`zip compression method ${String(method)} is not supported`);
}
async function extractZip(archive, destination) {
  await rm3(destination, { recursive: true, force: true });
  await mkdir3(destination, { recursive: true });
  const handle = await open2(archive, "r");
  const extracted = [];
  try {
    const size = (await handle.stat()).size;
    if (size < EOCD_SIZE) throw new Error(`not a zip archive: ${archive}`);
    const tailLength = Math.min(size, EOCD_SIZE + MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const eocd = findEndOfCentralDirectory(tail);
    if (eocd < 0) throw new Error(`not a zip archive (no central directory): ${archive}`);
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0) throw new Error("zip64 and multi-disk archives are not supported");
    if (entryCount === 65535 || centralSize === 4294967295 || centralOffset === 4294967295) {
      throw new Error("zip64 archives are not supported");
    }
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new Error(`zip central directory is corrupt at entry ${String(index)}`);
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const externalAttributes = central.readUInt32LE(cursor + 38);
      const localOffset = central.readUInt32LE(cursor + 42);
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      cursor += 46 + nameLength + extraLength + commentLength;
      if ((flags & 1) !== 0) throw new Error(`zip entry is encrypted: ${name}`);
      if (name === "") throw new Error("zip entry has no name");
      const local = Buffer.alloc(30);
      await handle.read(local, 0, local.length, localOffset);
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`zip local header is corrupt: ${name}`);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const mode = externalAttributes >>> 16 & 65535;
      const kind = mode & S_IFMT;
      const target = safeEntryPath(destination, name);
      const directory = name.endsWith("/") || kind === S_IFDIR;
      if (directory) {
        await mkdir3(target, { recursive: true });
        extracted.push(target);
        continue;
      }
      await mkdir3(path7.dirname(target), { recursive: true });
      if (kind === S_IFLNK) {
        const linkTarget = (await readEntry(handle, dataOffset, compressedSize, method)).toString("utf8");
        const resolved = path7.resolve(path7.dirname(target), linkTarget);
        const root = path7.resolve(destination);
        if (resolved !== root && !resolved.startsWith(`${root}${path7.sep}`)) {
          throw new Error(`zip symlink escapes the destination: ${name} -> ${linkTarget}`);
        }
        await symlink(linkTarget, target);
        extracted.push(target);
        continue;
      }
      if (compressedSize === 0) {
        await writeFile3(target, Buffer.alloc(0));
      } else if (method === 0 || method === 8) {
        const source = createReadStream(archive, { start: dataOffset, end: dataOffset + compressedSize - 1 });
        const sink = createWriteStream2(target);
        if (method === 8) await pipeline2(source, createInflateRaw(), sink);
        else await pipeline2(source, sink);
      } else {
        throw new Error(`zip compression method ${String(method)} is not supported: ${name}`);
      }
      const written = (await stat2(target)).size;
      if (uncompressedSize !== 4294967295 && written !== uncompressedSize) {
        throw new Error(`zip entry has the wrong size: ${name} (${String(written)} != ${String(uncompressedSize)})`);
      }
      const permissions = mode & 511;
      if (permissions !== 0) await chmod2(target, permissions).catch(() => {
      });
      extracted.push(target);
    }
    return extracted;
  } finally {
    await handle.close();
  }
}

// code/build/chrome-download.mjs
var CHROME_FOR_TESTING_MANIFEST = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
var ARTIFACT = "chrome-headless-shell";
var DOWNLOAD_TIMEOUT_MS = 15 * 6e4;
function chromeForTestingPlatform(platform = process.platform, arch = process.arch) {
  if (platform === "linux") {
    if (arch === "x64") return "linux64";
    if (arch === "arm64") return "linux-arm64";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "mac-x64";
    if (arch === "arm64") return "mac-arm64";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "win64";
    if (arch === "ia32") return "win32";
    return null;
  }
  return null;
}
function defaultChromeDownloadDir(env = process.env, platform = process.platform) {
  const configured = typeof env.DSH_MESH_SMOKE_CHROME_CACHE === "string" ? env.DSH_MESH_SMOKE_CHROME_CACHE.trim() : "";
  if (configured !== "") return path8.resolve(configured);
  if (platform === "win32") {
    const localAppData = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA !== "" ? env.LOCALAPPDATA : path8.join(os3.homedir(), "AppData", "Local");
    return path8.join(localAppData, "dsh-mesh", "chrome");
  }
  const xdg = typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME !== "" ? env.XDG_CACHE_HOME : path8.join(os3.homedir(), ".cache");
  return path8.join(xdg, "dsh-mesh", "chrome");
}
function binaryName(platform) {
  return platform === "win32" ? `${ARTIFACT}.exe` : ARTIFACT;
}
async function findCachedChrome(cacheDir, platformKey, platform) {
  let entries;
  try {
    entries = await readdir3(cacheDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort((left, right) => right.localeCompare(left, void 0, { numeric: true }));
  for (const version of versions) {
    const binary = path8.join(cacheDir, version, platformKey, binaryName(platform));
    const info = await stat3(binary).catch(() => null);
    if (info?.isFile() === true && info.size > 0) return { binary, version };
  }
  return null;
}
async function downloadFile(url, file, options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {
  });
  log(`GET ${url}`);
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
  });
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: ${url} -> HTTP ${String(response.status)}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  await mkdir4(path8.dirname(file), { recursive: true });
  const temporary = `${file}.part`;
  let received = 0;
  let nextPercent = 10;
  const source = Readable3.fromWeb(response.body);
  source.on("data", (chunk) => {
    received += chunk.length;
    if (total <= 0) return;
    const percent = Math.floor(received / total * 100);
    if (percent < nextPercent) return;
    nextPercent = Math.min(100, percent + 10);
    log(`downloading Chrome: ${String(percent)}% (${String(Math.round(received / 1048576))} MiB)`);
  });
  try {
    await pipeline3(source, createWriteStream3(temporary));
    await rename2(temporary, file);
  } catch (error) {
    await rm4(temporary, { force: true }).catch(() => {
    });
    throw error;
  }
  if (total > 0 && received !== total) {
    throw new Error(`download incomplete: ${url} (${String(received)} of ${String(total)} bytes)`);
  }
}
async function resolveArchive(manifestUrl, platformKey, options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(manifestUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 6e4)
  });
  if (!response.ok) throw new Error(`cannot read the Chrome for Testing manifest: HTTP ${String(response.status)}`);
  const body = await response.json();
  const stable = body?.channels?.Stable;
  const version = typeof stable?.version === "string" ? stable.version : "";
  const downloads = Array.isArray(stable?.downloads?.[ARTIFACT]) ? stable.downloads[ARTIFACT] : [];
  const entry = downloads.find((candidate) => candidate?.platform === platformKey);
  if (version === "" || typeof entry?.url !== "string") {
    throw new Error(`Chrome for Testing has no ${ARTIFACT} build for ${platformKey}`);
  }
  return { version, url: entry.url };
}
async function ensureDownloadedChrome(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const log = options.log ?? (() => {
  });
  const platformKey = chromeForTestingPlatform(platform, arch);
  if (platformKey === null) {
    throw new Error(`Chrome for Testing has no build for ${platform}-${arch}`);
  }
  const cacheDir = options.cacheDir ?? defaultChromeDownloadDir(env, platform);
  const cached = await findCachedChrome(cacheDir, platformKey, platform);
  if (cached !== null) {
    log(`using cached Chrome for Testing ${cached.version} (${platformKey}): ${cached.binary}`);
    return { ...cached, platform: platformKey, cacheDir, cached: true };
  }
  const archiveOverride = options.archiveUrl ?? (typeof env.DSH_MESH_SMOKE_CHROME_URL === "string" ? env.DSH_MESH_SMOKE_CHROME_URL.trim() : "");
  const manifestUrl = options.manifestUrl ?? (typeof env.DSH_MESH_SMOKE_CHROME_MANIFEST === "string" && env.DSH_MESH_SMOKE_CHROME_MANIFEST.trim() !== "" ? env.DSH_MESH_SMOKE_CHROME_MANIFEST.trim() : CHROME_FOR_TESTING_MANIFEST);
  const resolved = archiveOverride === "" ? await resolveArchive(manifestUrl, platformKey, options) : { version: "custom", url: archiveOverride };
  const version = resolved.version.replace(/[^0-9A-Za-z._-]/gu, "_");
  log(`no browser found; downloading Chrome for Testing ${version} (${platformKey})`);
  log(`archive: ${resolved.url}`);
  await mkdir4(cacheDir, { recursive: true });
  const temporary = await mkdtemp2(path8.join(cacheDir, ".download-"));
  try {
    const archive = path8.join(temporary, `${ARTIFACT}.zip`);
    await downloadFile(resolved.url, archive, options);
    log(`extracting Chrome for Testing ${version}`);
    const extracted = path8.join(temporary, "extract");
    await extractZip(archive, extracted);
    const binary = path8.join(temporary, "extract", `${ARTIFACT}-${platformKey}`, binaryName(platform));
    const info = await stat3(binary).catch(() => null);
    if (info?.isFile() !== true) {
      throw new Error(`the ${platformKey} archive did not contain ${ARTIFACT}-${platformKey}/${binaryName(platform)}`);
    }
    await chmod3(binary, 493);
    const finalDir = path8.join(cacheDir, version, platformKey);
    await mkdir4(path8.dirname(finalDir), { recursive: true });
    await rm4(finalDir, { recursive: true, force: true });
    await rename2(path8.dirname(binary), finalDir);
    const installed = path8.join(finalDir, binaryName(platform));
    for (const entry of await readdir3(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === version) continue;
      await rm4(path8.join(cacheDir, entry.name), { recursive: true, force: true }).catch(() => {
      });
    }
    log(`Chrome for Testing ${version} ready: ${installed}`);
    return { binary: installed, version, platform: platformKey, cacheDir, cached: false };
  } finally {
    await rm4(temporary, { recursive: true, force: true }).catch(() => {
    });
  }
}

// code/build/smoke.mjs
var MESH_LABEL = "Mesh";
var VIEWPORT = { width: 1440, height: 900 };
var DEFAULT_START_TIMEOUT_MS = 18e4;
var DEFAULT_PAGE_TIMEOUT_MS = 24e4;
var DEFAULT_PANEL_TIMEOUT_MS = 15e4;
function pathLookup(env, platform, names) {
  const key = platform === "win32" ? env.PATH ?? env.Path ?? "" : env.PATH ?? "";
  const separator = platform === "win32" ? ";" : ":";
  const dirs = key.split(separator).map((entry) => entry.trim()).filter((entry) => entry !== "");
  const found = [];
  for (const dir of dirs) {
    for (const name of names) found.push(path9.join(dir, name));
  }
  return found;
}
function chromeCandidates(env = process.env, platform = process.platform) {
  const configured = [env.DSH_MESH_SMOKE_CHROME, env.DSH_GATE_CHROME].filter((value) => typeof value === "string" && value !== "");
  const edge = platform === "win32" ? [
    path9.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path9.join(env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path9.join(env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe")
  ] : platform === "darwin" ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] : [
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/microsoft-edge-beta",
    "/usr/bin/microsoft-edge-dev",
    "/opt/microsoft/msedge/msedge",
    "/opt/microsoft/msedge-beta/msedge",
    "/opt/microsoft/msedge-dev/msedge"
  ];
  const chrome = platform === "win32" ? [
    path9.join(env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path9.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path9.join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe")
  ] : platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
  ] : [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/lib/chromium/chromium",
    "/snap/bin/chromium"
  ];
  const names = platform === "win32" ? ["chrome.exe", "msedge.exe", "chromium.exe"] : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
  return [...configured, ...chrome, ...edge, ...pathLookup(env, platform, names)].filter((value) => value !== "");
}
function findChrome(env = process.env, platform = process.platform) {
  const mode = platform === "win32" ? constants.F_OK : constants.X_OK;
  for (const candidate of chromeCandidates(env, platform)) {
    try {
      accessSync(candidate, mode);
      return candidate;
    } catch {
    }
  }
  return null;
}
async function resolveSmokeChrome(options, download2, log) {
  const env = options.env ?? process.env;
  const configured = options.chrome === void 0 ? findChrome(env) : options.chrome;
  if (typeof configured === "string" && configured !== "") {
    return { chrome: configured, source: "installed", error: null };
  }
  if (!download2) return { chrome: null, source: null, error: null };
  try {
    const downloaded = await ensureDownloadedChrome({
      env,
      cacheDir: options.chromeCacheDir,
      fetchImpl: options.fetchImpl,
      log
    });
    return { chrome: downloaded.binary, source: "downloaded", version: downloaded.version, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`automatic Chrome download failed: ${message}`);
    return { chrome: null, source: null, error: message };
  }
}
async function probeDownloadedChrome(chrome, log) {
  log(`checking the downloaded browser: ${chrome}`);
  const session = await ChromeSession.launch(chrome, { width: 1024, height: 768 });
  try {
    await session.evaluate("1");
  } finally {
    session.kill();
  }
}
function missingChromeReason(download2, error, suffix) {
  if (download2 && error !== null) return `no Chrome/Chromium/Edge found and the automatic download failed: ${error}; ${suffix}`;
  if (download2) return `no Chrome/Chromium/Edge found and no downloadable build is available for this host; ${suffix}`;
  return `no Chrome/Chromium/Edge found; ${suffix}`;
}
function browserStartReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/error while loading shared libraries|libnss3|libgbm|libatk/iu.test(message)) {
    return `${message}; the member is missing Chromium's runtime libraries (libnss3, libgbm, libatk, ...) \u2014 install them or set DSH_MESH_SMOKE_CHROME`;
  }
  return message;
}
function parseSmokeTarget(target) {
  const [os9, arch] = String(target ?? "").split("-");
  return { os: os9 ?? "", arch: arch ?? "" };
}
function targetOs(platform = process.platform) {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "darwin";
  return "linux";
}
function isNativeTarget(target, platform = process.platform, arch = process.arch) {
  const parsed = parseSmokeTarget(target);
  return parsed.os === targetOs(platform) && parsed.arch === arch;
}
function packageNode(root) {
  const candidates = process.platform === "win32" ? [path9.join(root, "runtime", "node", "node.exe"), path9.join(root, "runtime", "node", "bin", "node.exe")] : [path9.join(root, "runtime", "node", "bin", "node")];
  for (const candidate of candidates) {
    if (existsSync5(candidate)) return candidate;
  }
  return process.execPath;
}
function startProcess(options) {
  const detached = process.platform !== "win32";
  const child = spawn3(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached
  });
  const lines = [];
  let exited = false;
  const consume = (chunk) => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === "") continue;
      lines.push(line);
      if (lines.length > 400) lines.shift();
      options.log(`[${options.name}] ${line}`);
    }
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const signalGroup = (signal) => {
    try {
      if (detached && child.pid !== void 0) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
    }
  };
  return {
    child,
    get exited() {
      return exited;
    },
    tail: () => lines.slice(-30).join("\n"),
    async stop() {
      if (exited) {
        signalGroup("SIGKILL");
        return;
      }
      signalGroup("SIGTERM");
      const timer = setTimeout(() => signalGroup("SIGKILL"), 8e3);
      await exit;
      clearTimeout(timer);
      signalGroup("SIGKILL");
    }
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms: ${label}`)), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
async function waitFor(read, options) {
  const interval = options.intervalMs ?? 500;
  const deadline = Date.now() + options.timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (error !== null && typeof error === "object" && error.fatal === true) throw error;
      lastError = error;
    }
    await sleep(interval);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timed out after ${String(options.timeoutMs)}ms: ${options.label}${detail}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function cleanEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("DSH_") || key === "NODE_OPTIONS") continue;
    if (value !== void 0) env[key] = value;
  }
  return { ...env, ...overrides };
}
async function runNode(node, args, options) {
  const child = spawn3(node, args, { cwd: options.cwd, env: cleanEnv({}), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const consume = (chunk) => {
    const text = String(chunk);
    output = `${output}${text}`.slice(-16e3);
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() !== "") options.log(line);
    }
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  const result = await withTimeout(new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }), options.timeoutMs ?? 12e4, `${path9.basename(args[0] ?? "node")} ${String(args[1] ?? "")}`);
  if (result.code !== 0) {
    throw new Error(`${path9.basename(args[0] ?? "node")} exited ${String(result.signal ?? result.code)}: ${output.trim().slice(-1200)}`);
  }
  return output;
}
async function prepareInstallRoot(packageRoot, workDir) {
  const root = path9.join(workDir, "install");
  await rm5(root, { recursive: true, force: true });
  await mkdir5(path9.join(root, "config"), { recursive: true });
  await mkdir5(path9.join(root, "data"), { recursive: true });
  await mkdir5(path9.join(root, "home", "profiles", "web"), { recursive: true });
  await mkdir5(path9.join(root, "workspace"), { recursive: true });
  for (const directory of ["app", "code", "gate", "plugins", "shared"]) {
    const source = path9.join(packageRoot, directory);
    if (!existsSync5(source)) throw new Error(`package is missing ${directory}/: ${packageRoot}`);
    await symlink2(source, path9.join(root, directory), process.platform === "win32" ? "junction" : "dir");
  }
  const runtime = path9.join(packageRoot, "runtime");
  if (!existsSync5(runtime)) throw new Error(`package is missing runtime/: ${packageRoot}`);
  await symlink2(runtime, path9.join(root, "runtime"), process.platform === "win32" ? "junction" : "dir");
  const entry = path9.join(packageRoot, "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync5(entry)) throw new Error(`package has no DSH app entry: ${entry}`);
  const patch = path9.join(packageRoot, "config", "browse-picker.patch.yml");
  if (existsSync5(patch)) await copyFile(patch, path9.join(root, "config", "browse-picker.patch.yml"));
  return root;
}
async function wireProfile(options) {
  const candidates = [
    path9.join(options.packageRoot, "code", "deploy", "wire-profile.mjs"),
    path9.join(options.packageRoot, "plugins", "dsh-mesh", "code", "deploy", "wire-profile.mjs")
  ];
  const script = candidates.find((candidate) => existsSync5(candidate));
  if (script === void 0) {
    throw new Error("package carries no code/deploy/wire-profile.mjs; cannot wire the DSH profile");
  }
  const envFile2 = path9.join(options.root, "config", "gate.env");
  await writeFile4(envFile2, [
    `DSH_GATE_PORT=${String(options.port)}`,
    `DSH_GATE_PASSWORD=${options.password}`,
    `DSH_HOME=${options.home}`,
    `DSH_WORKDIR=${options.workdir}`,
    `DSH_GATE_DATA_DIR=${path9.join(options.root, "data")}`,
    ""
  ].join("\n"), { mode: 384 });
  const node = packageNode(options.packageRoot);
  const output = await runNode(node, [
    script,
    "--root",
    options.root,
    "--profile",
    path9.join(options.home, "profiles", "web"),
    "--env",
    envFile2,
    "--dsh-home",
    options.home,
    "--workdir",
    options.workdir,
    "--port",
    String(options.port),
    "--token",
    "dsh-mesh-smoke"
  ], { cwd: options.root, log: options.log });
  options.log(`profile wired: ${output.trim().split(/\r?\n/u).slice(-1)[0] ?? ""}`);
}
async function startStack(options) {
  const { root, node } = options;
  const tokenFile = path9.join(root, "data", "dsh-web.json");
  await rm5(tokenFile, { force: true });
  const supervisor = startProcess({
    command: node,
    // `--preserve-symlinks-main` keeps ROOT at the scratch install even when
    // the scratch `code` directory is a symlink. Older supervisors (packages
    // built before DSH_PACKAGE_ROOT was honoured) then still write their token
    // into the scratch `data/` rather than into the package being tested.
    args: ["--preserve-symlinks-main", path9.join(root, "code", "dsh-service", "supervisor.mjs")],
    cwd: root,
    env: cleanEnv({
      DSH_HOME: options.home,
      DSH_WORKDIR: options.workdir,
      DSH_AGENTS_HOME: path9.join(options.home, "agents"),
      DSH_WEB_PORT: "0",
      DSH_PACKAGE_ROOT: root
    }),
    name: "dsh",
    log: options.log
  });
  let token;
  try {
    token = await waitFor(async () => {
      if (supervisor.exited) {
        const error = new Error(`DSH supervisor exited before writing a launch URL:
${supervisor.tail()}`);
        error.fatal = true;
        throw error;
      }
      if (!existsSync5(tokenFile)) return null;
      try {
        const parsed = JSON.parse(await readFile6(tokenFile, "utf8"));
        return Number.isInteger(parsed.port) && parsed.port > 0 ? parsed : null;
      } catch {
        return null;
      }
    }, {
      timeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      intervalMs: 500,
      label: "dsh web launch URL (the package did not start)"
    });
  } catch (error) {
    await supervisor.stop();
    throw error;
  }
  options.log(`dsh web ready on 127.0.0.1:${String(token.port)}; starting the gateway`);
  const gate = startProcess({
    command: node,
    args: [path9.join(root, "gate", "server.mjs")],
    cwd: root,
    env: cleanEnv({
      DSH_HOME: options.home,
      DSH_WORKDIR: options.workdir,
      DSH_GATE_DATA_DIR: path9.join(root, "data"),
      DSH_GATE_PORT: String(options.port),
      // Never expose the throwaway instance beyond loopback: its password is
      // fixed for the test and the build host may be on a public network.
      DSH_GATE_BIND: "127.0.0.1",
      DSH_GATE_PASSWORD: options.password,
      DSH_GATE_NO_SPAWN: "1",
      DSH_WEB_TOKEN_FILE: tokenFile,
      DSH_GATE_MEMBER_PORT: String(options.port),
      DSH_PACKAGE_ROOT: root,
      DSH_APP_DIR: path9.join(root, "app"),
      DSH_GATE_PATCH: path9.join(root, "config", "browse-picker.patch.yml")
    }),
    name: "gate",
    log: options.log
  });
  try {
    await waitFor(async () => {
      if (gate.exited) {
        const error = new Error(`gateway exited before becoming healthy:
${gate.tail()}`);
        error.fatal = true;
        throw error;
      }
      const response = await fetch(`http://127.0.0.1:${String(options.port)}/__gate/health`, {
        signal: AbortSignal.timeout(2e3)
      });
      const body = await response.json().catch(() => null);
      return response.ok && body?.ok === true ? body : null;
    }, {
      timeoutMs: 9e4,
      intervalMs: 500,
      label: "gateway health (DSH did not become reachable)"
    });
  } catch (error) {
    await gate.stop();
    await supervisor.stop();
    throw error;
  }
  return {
    token,
    async close() {
      await gate.stop();
      await supervisor.stop();
    }
  };
}
async function loginCookie(base, password) {
  const response = await fetch(`${base}/__gate/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, next: "/" }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(15e3)
  });
  if (response.status !== 303 && response.status !== 302 && response.status !== 200) {
    throw new Error(`gate login answered HTTP ${String(response.status)}`);
  }
  const headers = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const raw = headers.find((value2) => value2.startsWith("dsh_gate=")) ?? "";
  const value = raw.split(";")[0]?.slice("dsh_gate=".length) ?? "";
  if (value === "") throw new Error("gate login did not return a dsh_gate cookie");
  return value;
}
async function pageSnapshot(session) {
  return withTimeout(session.evaluate(`(() => {
    const text = document.body ? document.body.innerText : ''
    const root = document.querySelector('#root')
    const meshButtons = [...document.querySelectorAll('button')]
      .filter(button => button.textContent.trim() === ${JSON.stringify(MESH_LABEL)})
    const fatal = /Failed to load plugins|web boot: .*did not activate/u.test(text)
    return {
      url: location.href,
      ready: document.readyState,
      login: Boolean(document.querySelector('#password')),
      rootChildren: root ? root.children.length : -1,
      meshButtons: meshButtons.length,
      fatal,
      text: text.slice(0, 2000),
    }
  })()`), 15e3, "read the page");
}
async function loginAndBoot(session, options) {
  await withTimeout(session.goto(`${options.base}/`, 6e4), 65e3, "open the gateway");
  let submitted = false;
  const state = await waitFor(async () => {
    const snapshot = await pageSnapshot(session);
    if (snapshot.fatal) {
      const error = new Error(`DSH boot failed in the browser:
${snapshot.text.slice(0, 1200)}`);
      error.fatal = true;
      throw error;
    }
    if (snapshot.login && !submitted) {
      const filled = await withTimeout(session.evaluate(`(() => {
        const input = document.querySelector('#password')
        const form = input ? input.form : null
        if (!input || !form) return false
        input.value = ${JSON.stringify(options.password)}
        form.submit()
        return true
      })()`), 1e4, "submit the gate password");
      if (filled) {
        submitted = true;
        options.log("gate password submitted; waiting for the DSH shell");
      }
      return null;
    }
    if (snapshot.meshButtons > 0) return snapshot;
    return null;
  }, {
    timeoutMs: options.timeoutMs,
    intervalMs: 750,
    label: "DSH shell with a Mesh sidebar entry"
  });
  return state;
}
async function inspectInChrome(options) {
  const session = await ChromeSession.launch(options.chrome, VIEWPORT);
  const screenshots = [];
  const checks = [];
  try {
    if (typeof options.cookie === "string" && options.cookie !== "") {
      try {
        await session.setCookie("dsh_gate", options.cookie, options.base);
      } catch (error) {
        options.log(`could not install the gate cookie: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const state = await loginAndBoot(session, {
      base: options.base,
      password: options.password,
      timeoutMs: options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
      log: options.log
    });
    checks.push({
      name: "dsh-boot",
      ok: state.rootChildren > 0 && state.text.trim() !== "",
      detail: `${String(state.rootChildren)} root child(ren), ${String(state.text.length)} chars`
    });
    checks.push({
      name: "no-plugin-errors",
      ok: !state.fatal,
      detail: state.fatal ? "the page reported failed plugins" : "no failed-plugin banner"
    });
    checks.push({
      name: "mesh-sidebar",
      ok: state.meshButtons > 0,
      detail: `${String(state.meshButtons)} sidebar button(s) labelled Mesh`
    });
    const shellShot = path9.join(options.screenshotDir, `dsh-${options.target}.png`);
    await mkdir5(options.screenshotDir, { recursive: true });
    await writeFile4(shellShot, await withTimeout(session.screenshot(), 3e4, "screenshot the shell"));
    screenshots.push(shellShot);
    options.log(`screenshot: ${shellShot}`);
    const clicked = await withTimeout(session.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(candidate => candidate.textContent.trim() === ${JSON.stringify(MESH_LABEL)})
      if (!button) return false
      button.click()
      return true
    })()`), 1e4, "click the Mesh sidebar entry");
    if (!clicked) {
      checks.push({ name: "mesh-panel", ok: false, detail: "the Mesh sidebar entry disappeared before the click" });
    } else {
      let mode = "";
      try {
        mode = String(await waitFor(async () => {
          return withTimeout(session.evaluate(
            "document.querySelector('.dsh-pw-page') ? 'page' : ''"
          ), 15e3, "read the Mesh panel");
        }, {
          timeoutMs: options.panelTimeoutMs ?? DEFAULT_PANEL_TIMEOUT_MS,
          intervalMs: 750,
          label: "the Mesh panel to finish loading"
        }));
      } catch {
        const marker = await withTimeout(session.evaluate(`(() => {
          if (document.querySelector('.dsh-pw-page')) return 'page'
          if (document.querySelector('.dsh-pw-boot')) return 'boot'
          return ''
        })()`), 3e4, "read the Mesh panel markers").catch(() => "");
        mode = String(marker);
        if (mode === "boot") {
          checks.push({ name: "mesh-panel", ok: true, detail: "the Mesh panel is in its boot state (API still starting)" });
        }
      }
      if (mode === "page") {
        checks.push({ name: "mesh-panel", ok: true, detail: "the Mesh panel finished loading" });
      } else if (mode === "") {
        checks.push({ name: "mesh-panel", ok: false, detail: "the Mesh panel markup never appeared" });
      }
      const panelShot = path9.join(options.screenshotDir, `mesh-${options.target}.png`);
      await writeFile4(panelShot, await withTimeout(session.screenshot(), 3e4, "screenshot the Mesh panel"));
      screenshots.push(panelShot);
      options.log(`screenshot: ${panelShot}`);
    }
    return { checks, screenshots, state };
  } catch (error) {
    if (error !== null && typeof error === "object") {
      error.checks = checks;
      error.screenshots = screenshots;
    }
    if (screenshots.length === 0) {
      try {
        await mkdir5(options.screenshotDir, { recursive: true });
        const failure = path9.join(options.screenshotDir, `failure-${options.target}.png`);
        await writeFile4(failure, await withTimeout(session.screenshot(), 15e3, "screenshot the failure"));
        screenshots.push(failure);
        options.log(`screenshot: ${failure}`);
      } catch {
      }
    }
    throw error;
  } finally {
    session.kill();
  }
}
function skipped(reason, base) {
  return {
    ok: true,
    status: "skipped",
    reason,
    ...base,
    durationMs: 0,
    checks: [],
    screenshots: []
  };
}
async function runPackageSmoke(options) {
  const started = Date.now();
  const target = String(options.target ?? "");
  const base = { target, packageRoot: options.packageRoot };
  if (options.packageRoot === void 0 || !existsSync5(options.packageRoot)) {
    return { ...skipped("package directory does not exist", base), ok: false, status: "failed", error: `package directory does not exist: ${String(options.packageRoot)}` };
  }
  if (!isNativeTarget(target)) {
    return skipped(`${target} cannot run on ${targetOs()}-${process.arch}`, base);
  }
  const ownsWorkDir = options.workDir === void 0;
  const workDir = options.workDir ?? await mkdtemp3(path9.join(os4.tmpdir(), "dsh-mesh-smoke-"));
  await mkdir5(workDir, { recursive: true });
  const logFile = path9.join(workDir, "smoke.log");
  const log = (line) => {
    const text = String(line);
    void appendFile(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${text}
`).catch(() => {
    });
    options.log?.(text);
  };
  const screenshotDir = options.screenshotDir ?? workDir;
  const download2 = options.downloadChrome === true;
  const resolved = await resolveSmokeChrome(options, download2, log);
  if (resolved.chrome === null) {
    const reason = missingChromeReason(download2, resolved.error, "set DSH_MESH_SMOKE_CHROME or run with --no-smoke");
    if (ownsWorkDir && options.keep !== true) await rm5(workDir, { recursive: true, force: true }).catch(() => {
    });
    return options.required === true ? { ...skipped(reason, base), ok: false, status: "failed", error: reason } : skipped(reason, base);
  }
  if (resolved.source === "downloaded") {
    try {
      await probeDownloadedChrome(resolved.chrome, log);
    } catch (error) {
      const reason = `downloaded Chrome for Testing ${resolved.version ?? ""} could not start: ${browserStartReason(error)}`;
      log(reason);
      if (ownsWorkDir && options.keep !== true) await rm5(workDir, { recursive: true, force: true }).catch(() => {
      });
      return options.required === true ? { ...skipped(reason, base), ok: false, status: "failed", error: reason } : skipped(reason, base);
    }
  }
  const chrome = resolved.chrome;
  const chromeLabel = `${chrome}${resolved.source === "downloaded" ? ` (downloaded ${resolved.version ?? ""})` : ""}`;
  let root;
  let stack;
  try {
    log(`smoke ${target}: package ${options.packageRoot}; chrome ${chromeLabel}`);
    root = await prepareInstallRoot(options.packageRoot, workDir);
    const home = path9.join(root, "home");
    const worktree = path9.join(root, "workspace");
    const port = await freePort();
    await wireProfile({
      packageRoot: options.packageRoot,
      root,
      home,
      workdir: worktree,
      port,
      password: "dsh-mesh-smoke",
      log
    });
    stack = await startStack({
      root,
      node: packageNode(options.packageRoot),
      home,
      workdir: worktree,
      port,
      password: "dsh-mesh-smoke",
      log,
      startTimeoutMs: options.startTimeoutMs
    });
    let cookie = null;
    try {
      cookie = await loginCookie(`http://127.0.0.1:${String(port)}`, "dsh-mesh-smoke");
    } catch (error) {
      log(`cookie login failed (falling back to the form): ${error instanceof Error ? error.message : String(error)}`);
    }
    const inspected = await inspectInChrome({
      base: `http://127.0.0.1:${String(port)}`,
      password: "dsh-mesh-smoke",
      chrome,
      screenshotDir,
      target,
      cookie,
      timeoutMs: options.pageTimeoutMs,
      panelTimeoutMs: options.panelTimeoutMs,
      log
    });
    const failed = inspected.checks.filter((check) => !check.ok);
    const result = {
      ok: failed.length === 0,
      status: failed.length === 0 ? "passed" : "failed",
      target,
      packageRoot: options.packageRoot,
      chrome,
      chromeSource: resolved.source,
      ...resolved.version === void 0 ? {} : { chromeVersion: resolved.version },
      checks: inspected.checks,
      screenshots: inspected.screenshots,
      logFile,
      durationMs: Date.now() - started,
      ...failed.length === 0 ? {} : { error: failed.map((check) => `${check.name}: ${check.detail}`).join("; ") }
    };
    log(`smoke ${target}: ${result.status}${result.error === void 0 ? "" : ` (${result.error})`}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`smoke ${target}: failed: ${message}`);
    return {
      ok: false,
      status: "failed",
      target,
      packageRoot: options.packageRoot,
      chrome,
      chromeSource: resolved.source,
      ...resolved.version === void 0 ? {} : { chromeVersion: resolved.version },
      checks: Array.isArray(error?.checks) ? error.checks : [],
      screenshots: Array.isArray(error?.screenshots) ? error.screenshots : [],
      logFile,
      error: message,
      durationMs: Date.now() - started
    };
  } finally {
    await stack?.close().catch(() => {
    });
    if (root !== void 0 && options.keep !== true) await rm5(root, { recursive: true, force: true }).catch(() => {
    });
    if (ownsWorkDir && options.keep !== true) await rm5(workDir, { recursive: true, force: true }).catch(() => {
    });
  }
}

// code/build/stamp.mjs
import { mkdir as mkdir6, readFile as readFile7, readdir as readdir4, rename as rename3, writeFile as writeFile5 } from "node:fs/promises";
import os5 from "node:os";
import path10 from "node:path";
function defaultStampFile() {
  return path10.join(os5.homedir(), ".dsh", "mesh", "build-stamp.json");
}
function buildStampDate(date = /* @__PURE__ */ new Date()) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}
function letterFor(index) {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error(`invalid build sequence: ${String(index)}`);
  let value = index;
  let letters = "";
  while (value > 0) {
    value -= 1;
    letters = String.fromCharCode(65 + value % 26) + letters;
    value = Math.floor(value / 26);
  }
  return letters;
}
function letterIndex(letters) {
  let value = 0;
  for (const char of String(letters)) value = value * 26 + (char.charCodeAt(0) - 64);
  return value;
}
function isValidBuildStamp(value) {
  return typeof value === "string" && /^\d{8}[A-Z]+$/u.test(value);
}
function highestFromNames(names, date) {
  let highest = 0;
  for (const name of names) {
    const match = new RegExp(`-${date}([A-Z]+)-(?:linux|win|darwin)-`, "u").exec(name);
    if (match !== null) highest = Math.max(highest, letterIndex(match[1]));
  }
  return highest;
}
async function nextBuildStamp(options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const date = buildStampDate(now);
  const stateFile = options.stateFile ?? defaultStampFile();
  const packagesDir = options.packagesDir ?? path10.join(os5.homedir(), ".dsh", "packages");
  let state = {};
  try {
    state = JSON.parse(await readFile7(stateFile, "utf8"));
  } catch {
    state = {};
  }
  let next = state?.date === date && Number.isSafeInteger(state.next) && state.next > 0 ? state.next : 1;
  const names = await readdir4(packagesDir).catch(() => []);
  next = Math.max(next, highestFromNames(names, date) + 1);
  const stamp = `${date}${letterFor(next)}`;
  await mkdir6(path10.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${String(process.pid)}.tmp`;
  await writeFile5(temporary, `${JSON.stringify({
    format: 1,
    date,
    next: next + 1,
    last: stamp,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  }, null, 2)}
`, "utf8");
  await rename3(temporary, stateFile);
  return stamp;
}

// code/build/progress.mjs
var BUILD_DONE = 65;
var PACKAGE_END = 95;
var STAGE_FACTOR = { start: 0, smoke: 0.55, end: 1 };
function targetRange(targets, target) {
  const list = Array.isArray(targets) && targets.length > 0 ? targets : ["linux-x64"];
  const index = Math.max(0, list.indexOf(target));
  const span = (PACKAGE_END - BUILD_DONE) / list.length;
  return {
    start: Math.round(BUILD_DONE + span * index),
    end: Math.round(BUILD_DONE + span * (index + 1))
  };
}
function targetPercent(targets, target, stage = "start") {
  const { start, end } = targetRange(targets, target);
  const factor = STAGE_FACTOR[stage] ?? 0;
  return Math.round(start + (end - start) * factor);
}
function phaseFromLine(line, targets = ["linux-x64"]) {
  const text = String(line);
  if (text.includes("job created")) return { phase: "prepare", percent: 2 };
  if (text.includes("extracting ")) return { phase: "prepare", percent: 6 };
  if (text.includes("needs-fix")) return { phase: "apply", percent: 14, status: "needs-fix" };
  if (/^(?:applied|skipped) /u.test(text)) return { phase: "apply", percent: 11 };
  if (text.includes("$ pnpm install") || text.includes("$ pnpm i")) return { phase: "build", percent: 18 };
  if (text.includes("$ pnpm run build:web") || text.includes("$ pnpm build")) return { phase: "build", percent: 50 };
  if (text.includes("frontend installed") || text.includes("patching ")) {
    const first = Array.isArray(targets) && targets.length > 0 ? targets[0] : "linux-x64";
    return { phase: "package", percent: targetPercent(targets, first, "start"), currentTarget: first };
  }
  const packaged = /^packaged (\S+):/u.exec(text);
  if (packaged !== null) {
    return {
      phase: "package",
      percent: targetPercent(targets, packaged[1], "end"),
      currentTarget: packaged[1]
    };
  }
  const smoke = /^smoke (\S+): (starting|passed|skipped|failed)/u.exec(text);
  if (smoke !== null) {
    if (smoke[2] === "failed") {
      return { phase: "smoke", percent: targetPercent(targets, smoke[1], "end"), currentTarget: smoke[1], status: "smoke-failed" };
    }
    return {
      phase: "smoke",
      percent: targetPercent(targets, smoke[1], smoke[2] === "starting" ? "smoke" : "end"),
      currentTarget: smoke[1]
    };
  }
  if (text.includes("release asset ") || text.includes("release publish ") || /^(?:github|gitee) (?:upload|remove|create)/u.test(text)) {
    return { phase: "publish", percent: 97 };
  }
  if (text.includes("build complete")) return { phase: "fetch", percent: 96 };
  if (text.includes("failed:")) return { phase: "failed", status: "failed" };
  return null;
}

// code/shared/release.mjs
import { createHash as createHash2 } from "node:crypto";
import { createReadStream as createReadStream3, createWriteStream as createWriteStream5 } from "node:fs";
import { chmod as chmod4, mkdtemp as mkdtemp4, mkdir as mkdir7, readFile as readFile8, rm as rm7, stat as stat5, writeFile as writeFile6 } from "node:fs/promises";
import { homedir, tmpdir as tmpdir2 } from "node:os";
import path11 from "node:path";
import { finished } from "node:stream/promises";

// code/shared/http-client.mjs
import { createReadStream as createReadStream2, createWriteStream as createWriteStream4 } from "node:fs";
import { rm as rm6, rename as rename4, stat as stat4 } from "node:fs/promises";
import http2 from "node:http";
import https2 from "node:https";
import { PassThrough, Readable as Readable4 } from "node:stream";
import tls2 from "node:tls";
var MAX_REDIRECTS2 = 10;
var MAX_ERROR_BODY = 64 * 1024;
function parseProxyUrl2(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") throw new Error("proxy URL is empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`proxy is not a URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`proxy must be http or https, got ${url.protocol}`);
  }
  if (url.hostname === "") throw new Error(`proxy has no host: ${value}`);
  const port = url.port === "" ? url.protocol === "https:" ? 443 : 80 : Number.parseInt(url.port, 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error(`proxy has no valid port: ${value}`);
  const auth = url.username === "" ? null : `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return { href: `${url.protocol}//${url.host}`, protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/gu, ""), port, auth };
}
function normalizeHeaders(input) {
  const headers = {};
  if (input === void 0 || input === null) return headers;
  for (const [name, value] of Object.entries(input)) {
    if (value === void 0 || value === null) continue;
    headers[String(name).toLowerCase()] = String(value);
  }
  return headers;
}
function connectTunnel2(proxy2, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const authority = `${host}:${String(port)}`;
    const request = (proxy2.protocol === "https:" ? https2 : http2).request({
      host: proxy2.hostname,
      port: proxy2.port,
      method: "CONNECT",
      path: authority,
      headers: {
        host: authority,
        ...proxy2.auth === null ? {} : { "proxy-authorization": `Basic ${Buffer.from(proxy2.auth).toString("base64")}` }
      },
      timeout: timeoutMs
    });
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT ${authority}: HTTP ${String(response.statusCode)}`));
        return;
      }
      socket.setTimeout(0);
      resolve(socket);
    });
    request.once("timeout", () => request.destroy(new Error(`proxy CONNECT ${authority} timed out after ${String(timeoutMs)}ms`)));
    request.once("error", reject);
    request.end();
  });
}
function writeBody(request, options) {
  const body = options.body;
  if (body === void 0 || body === null) {
    request.end();
    return;
  }
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (options.headers["content-length"] === void 0) options.headers["content-length"] = String(buffer.length);
    request.end(buffer);
    return;
  }
  if (typeof body.pipe === "function") {
    if (options.length !== void 0 && options.headers["content-length"] === void 0) {
      options.headers["content-length"] = String(options.length);
    }
    body.once("error", (error) => request.destroy(error));
    body.pipe(request);
    return;
  }
  throw new Error("unsupported request body type");
}
function requestOnce2(href, options) {
  const target = new URL(href);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(new Error(`unsupported URL protocol: ${target.protocol}`));
  }
  const httpsTarget = target.protocol === "https:";
  const port = target.port === "" ? httpsTarget ? 443 : 80 : Number.parseInt(target.port, 10);
  const headers = { host: target.host, "user-agent": "dsh-mesh-release/1", ...normalizeHeaders(options.headers) };
  const proxy2 = options.proxy ?? null;
  const connectTimeoutMs = options.timeoutMs ?? 6e4;
  const idleTimeoutMs = options.idleTimeoutMs ?? connectTimeoutMs;
  const finish = (response, agent = null) => {
    const result = {
      statusCode: response.statusCode ?? 0,
      statusMessage: response.statusMessage ?? "",
      headers: normalizeHeaders(response.headers),
      stream: response,
      url: href
    };
    if (agent !== null) response.once("end", () => agent.destroy());
    return result;
  };
  return new Promise((resolve, reject) => {
    const common = {
      method: options.method ?? "GET",
      headers,
      timeout: idleTimeoutMs
    };
    const attach = (request, agent) => {
      request.once("response", (response) => resolve(finish(response, agent)));
      request.once("timeout", () => request.destroy(new Error(`request to ${href} was idle for ${String(idleTimeoutMs)}ms`)));
      request.once("error", reject);
      try {
        writeBody(request, { ...options, headers });
      } catch (error) {
        request.destroy(error);
      }
    };
    if (!httpsTarget) {
      if (proxy2 !== null) {
        const request = http2.request({
          host: proxy2.hostname,
          port: proxy2.port,
          method: common.method,
          path: target.href,
          headers: {
            ...headers,
            ...proxy2.auth === null ? {} : { "proxy-authorization": `Basic ${Buffer.from(proxy2.auth).toString("base64")}` }
          },
          timeout: idleTimeoutMs
        });
        attach(request, null);
        return;
      }
      attach(http2.request({
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        ...common
      }), null);
      return;
    }
    if (proxy2 === null) {
      attach(https2.request({
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        ...common
      }), null);
      return;
    }
    connectTunnel2(proxy2, target.hostname, port, connectTimeoutMs).then((socket) => {
      const secure = tls2.connect({ socket, servername: target.hostname });
      secure.once("error", reject);
      secure.once("secureConnect", () => {
        const agent = new https2.Agent({ keepAlive: false, maxSockets: 1 });
        agent.createConnection = (_options, callback) => {
          callback(null, secure);
          return secure;
        };
        attach(https2.request({
          hostname: target.hostname,
          port,
          path: `${target.pathname}${target.search}`,
          ...common,
          agent
        }), agent);
      });
    }).catch(reject);
  });
}
async function readText(stream, limit = MAX_ERROR_BODY) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) {
      stream.destroy();
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function drain2(stream) {
  try {
    for await (const _chunk of stream) {
    }
  } catch {
  }
}
var REDIRECTS = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
async function openResponse(href, options = {}) {
  const proxy2 = typeof options.proxy === "string" ? options.proxy.trim() === "" ? null : parseProxyUrl2(options.proxy) : options.proxy ?? null;
  const method = String(options.method ?? "GET").toUpperCase();
  const follow = options.followRedirects ?? (method === "GET" || method === "HEAD");
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS2;
  let current = href;
  let headers = normalizeHeaders(options.headers);
  if (options.body !== void 0 && options.body !== null && headers["content-length"] === void 0) {
    if (typeof options.body === "string" || Buffer.isBuffer(options.body)) {
      headers["content-length"] = String(Buffer.byteLength(options.body));
    } else if (typeof options.length === "number") {
      headers["content-length"] = String(options.length);
    }
  }
  for (let redirect = 0; ; redirect += 1) {
    const response = await requestOnce2(current, {
      method,
      headers,
      body: options.body,
      length: options.length,
      proxy: proxy2,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs
    });
    const location = response.headers.location;
    if (!follow || !REDIRECTS.has(response.statusCode) || location === void 0) {
      return { ...response, url: current };
    }
    if (redirect >= maxRedirects) {
      await drain2(response.stream);
      throw new Error(`too many redirects for ${href}`);
    }
    await drain2(response.stream);
    const next = new URL(location, current);
    if (next.origin !== new URL(current).origin) {
      delete headers.authorization;
      delete headers.cookie;
      delete headers["proxy-authorization"];
    }
    current = next.href;
  }
}
async function requestJson(url, options = {}) {
  const headers = { ...normalizeHeaders(options.headers) };
  let body;
  if (options.json !== void 0) {
    body = Buffer.from(JSON.stringify(options.json));
    headers["content-type"] ??= "application/json";
    headers["content-length"] = String(body.length);
  }
  const response = await openResponse(url, {
    method: options.method ?? (body === void 0 ? "GET" : "POST"),
    headers,
    body,
    proxy: options.proxy,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    followRedirects: options.followRedirects
  });
  const text = await readText(response.stream, 1024 * 1024);
  let json2;
  try {
    json2 = text === "" ? null : JSON.parse(text);
  } catch {
    json2 = null;
  }
  return { status: response.statusCode, headers: response.headers, text, json: json2 };
}
async function uploadFile(url, options) {
  const log = options.log ?? (() => {
  });
  const info = await stat4(options.file);
  const retries = Number.isSafeInteger(options.retries) ? Math.max(0, options.retries) : 2;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const delay = 1e3 * 2 ** (attempt - 1);
      log(`upload retry ${String(attempt)}/${String(retries)} in ${String(delay)}ms: ${lastError === null ? "" : lastError.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const stream = createReadStream2(options.file);
    const started = Date.now();
    let sent = 0;
    let lastReport = 0;
    let lastSent = 0;
    stream.on("data", (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastReport < 250) return;
      const speed = (sent - lastSent) / Math.max(1e-3, (now - lastReport) / 1e3);
      lastReport = now;
      lastSent = sent;
      options.onProgress?.({
        bytes: sent,
        totalBytes: info.size,
        percent: info.size > 0 ? Math.min(100, Math.round(sent / info.size * 100)) : 0,
        speed
      });
    });
    try {
      const response = await openResponse(url, {
        method: options.method ?? "POST",
        headers: options.headers,
        body: stream,
        length: info.size,
        proxy: options.proxy,
        timeoutMs: options.timeoutMs ?? 6e4,
        idleTimeoutMs: options.idleTimeoutMs ?? 3e5,
        followRedirects: false
      });
      const text = await readText(response.stream, 1024 * 1024);
      let json2 = null;
      try {
        json2 = text === "" ? null : JSON.parse(text);
      } catch {
        json2 = null;
      }
      if (response.statusCode === 429 || response.statusCode >= 500) {
        lastError = new Error(`upload ${url} answered HTTP ${String(response.statusCode)}: ${text.trim().slice(0, 300)}`);
        if (attempt < retries) continue;
        throw lastError;
      }
      return { status: response.statusCode, headers: response.headers, text, json: json2, bytes: info.size };
    } catch (error) {
      stream.destroy();
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= retries) throw lastError;
    }
  }
  throw lastError ?? new Error(`upload ${url} failed`);
}
async function multipartFileBody(options) {
  const boundary = `----dsh-mesh-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const info = await stat4(options.file);
  const fields = options.fields ?? {};
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="${name}"\r
\r
${value}\r
`));
  }
  chunks.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="file"; filename="${options.name}"\r
Content-Type: ${options.type ?? "application/octet-stream"}\r
\r
`));
  const head = Buffer.concat(chunks);
  const tail = Buffer.from(`\r
--${boundary}--\r
`);
  const length = head.length + info.size + tail.length;
  const body = new PassThrough();
  body.write(head);
  const file = createReadStream2(options.file);
  file.once("error", (error) => body.destroy(error));
  file.pipe(body, { end: false });
  file.once("end", () => {
    body.end(tail);
  });
  return { body, length, contentType: `multipart/form-data; boundary=${boundary}` };
}
function isSuccess(status) {
  return status >= 200 && status < 300;
}

// code/shared/release.mjs
var DEFAULT_RELEASE_TAG = "latest";
var DEFAULT_PART_BYTES = 85 * 1024 * 1024;
var MAX_PART_BYTES = 95 * 1024 * 1024;
var LATEST_MANIFEST_NAME = "latest.json";
var GITEE_REPO_QUOTA_BYTES = 950 * 1024 * 1024;
function defaultReleaseConfigFile() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : path11.join(homedir(), ".dsh");
  return path11.join(home, "mesh", "release.json");
}
function normalizeRepo(value) {
  if (value === null || typeof value !== "object") return { owner: "", repo: "" };
  const owner = String(value.owner ?? "").trim();
  const repo = String(value.repo ?? "").trim();
  const valid = (part) => /^[A-Za-z0-9_.-]+$/u.test(part);
  return { owner: valid(owner) ? owner : "", repo: valid(repo) ? repo : "" };
}
async function loadReleaseConfig(options = {}) {
  const file = options.file ?? defaultReleaseConfigFile();
  const env = options.env ?? process.env;
  let parsed = {};
  let fileError = null;
  try {
    parsed = JSON.parse(await readFile8(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
  } catch (error) {
    if (error?.code !== "ENOENT") fileError = error instanceof Error ? error.message : String(error);
    parsed = {};
  }
  const github = normalizeRepo(parsed.github);
  const gitee = normalizeRepo(parsed.gitee);
  const githubToken = String(env.DSH_MESH_GITHUB_TOKEN ?? parsed.github?.token ?? "").trim();
  const giteeToken = String(env.DSH_MESH_GITEE_TOKEN ?? parsed.gitee?.token ?? "").trim();
  const requestedTag = String(parsed.tag ?? DEFAULT_RELEASE_TAG).trim();
  const tag = /^[A-Za-z0-9._-]{1,64}$/u.test(requestedTag) ? requestedTag : DEFAULT_RELEASE_TAG;
  const requestedPart = Number(parsed.partBytes);
  const partBytes = Number.isSafeInteger(requestedPart) && requestedPart >= 1024 * 1024 ? Math.min(requestedPart, MAX_PART_BYTES) : DEFAULT_PART_BYTES;
  const enabled = parsed.enabled !== false;
  const result = {
    file,
    fileError,
    enabled,
    tag,
    partBytes,
    github: {
      ...github,
      token: githubToken,
      enabled: enabled && github.owner !== "" && github.repo !== "" && githubToken !== ""
    },
    gitee: {
      ...gitee,
      token: giteeToken,
      enabled: enabled && gitee.owner !== "" && gitee.repo !== "" && giteeToken !== "",
      // Gitee needs a real commit-ish to point the `latest` tag at.
      branch: typeof parsed.gitee?.branch === "string" && parsed.gitee.branch.trim() !== "" ? parsed.gitee.branch.trim() : "main"
    }
  };
  return result;
}
function sanitizeReleaseConfig(config) {
  return {
    file: config.file,
    fileError: config.fileError ?? null,
    enabled: config.enabled === true,
    tag: config.tag,
    partBytes: config.partBytes,
    github: {
      owner: config.github?.owner ?? "",
      repo: config.github?.repo ?? "",
      enabled: config.github?.enabled === true,
      hasToken: String(config.github?.token ?? "") !== ""
    },
    gitee: {
      owner: config.gitee?.owner ?? "",
      repo: config.gitee?.repo ?? "",
      branch: config.gitee?.branch ?? "main",
      enabled: config.gitee?.enabled === true,
      hasToken: String(config.gitee?.token ?? "") !== ""
    }
  };
}
async function saveReleaseConfig(options) {
  const file = options.file ?? defaultReleaseConfigFile();
  const input = options.input ?? {};
  const existing = await loadReleaseConfig({ file, env: options.env ?? {} });
  const github = normalizeRepo(input.github ?? {});
  const gitee = normalizeRepo(input.gitee ?? {});
  const githubToken = typeof input.github?.token === "string" && input.github.token.trim() !== "" ? input.github.token.trim() : existing.github?.token ?? "";
  const giteeToken = typeof input.gitee?.token === "string" && input.gitee.token.trim() !== "" ? input.gitee.token.trim() : existing.gitee?.token ?? "";
  const tag = String(input.tag ?? existing.tag ?? DEFAULT_RELEASE_TAG).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(tag)) throw new Error(`release tag is invalid: ${tag}`);
  const requestedPart = Number(input.partBytes ?? existing.partBytes);
  if (Number.isFinite(requestedPart) && (requestedPart < 1024 * 1024 || requestedPart > MAX_PART_BYTES)) {
    throw new Error(`part size must be between 1 MiB and ${String(MAX_PART_BYTES)} bytes`);
  }
  const branch = String(input.gitee?.branch ?? existing.gitee?.branch ?? "main").trim();
  if (!/^[A-Za-z0-9._/-]{1,120}$/u.test(branch)) throw new Error(`Gitee branch is invalid: ${branch}`);
  const stored = {
    enabled: input.enabled === void 0 ? existing.enabled !== false : input.enabled === true,
    tag,
    partBytes: Number.isFinite(requestedPart) ? Math.min(Math.round(requestedPart), MAX_PART_BYTES) : DEFAULT_PART_BYTES,
    github: { owner: github.owner, repo: github.repo, token: githubToken },
    gitee: { owner: gitee.owner, repo: gitee.repo, token: giteeToken, branch }
  };
  await mkdir7(path11.dirname(file), { recursive: true });
  await writeFile6(file, `${JSON.stringify(stored, null, 2)}
`, { encoding: "utf8", mode: 384 });
  await chmod4(file, 384).catch(() => {
  });
  return loadReleaseConfig({ file, env: options.env ?? {} });
}
function publicAssetUrl(value) {
  try {
    const url = new URL(value);
    for (const name of ["access_token", "token", "access-token"]) url.searchParams.delete(name);
    return url.href;
  } catch {
    return value;
  }
}
function latestManifestSources(config) {
  const sources = { github: null, gitee: null };
  if (config?.enabled !== false && config.github?.owner && config.github?.repo) {
    sources.github = `${config.github.webBase ?? "https://github.com"}/${config.github.owner}/${config.github.repo}/releases/download/${config.tag}/${LATEST_MANIFEST_NAME}`;
  }
  if (config?.enabled !== false && config.gitee?.owner && config.gitee?.repo) {
    sources.gitee = `${config.gitee.webBase ?? "https://gitee.com"}/${config.gitee.owner}/${config.gitee.repo}/releases/download/${config.tag}/${LATEST_MANIFEST_NAME}`;
  }
  return sources;
}
function latestManifestUrls(config) {
  const sources = latestManifestSources(config);
  return [sources.github, sources.gitee].filter((url) => typeof url === "string");
}
function releaseAssetUrl(config, repo, name) {
  const target = config[repo];
  const base = target.webBase ?? (repo === "github" ? "https://github.com" : "https://gitee.com");
  return `${base}/${target.owner}/${target.repo}/releases/download/${config.tag}/${encodeURIComponent(name)}`;
}
async function sha256File2(file) {
  const hash = createHash2("sha256");
  await finished(createReadStream3(file).on("data", (chunk) => hash.update(chunk)));
  return hash.digest("hex");
}
async function copyRange(source, destination, start, end) {
  const input = createReadStream3(source, { start, end });
  const output = createWriteStream5(destination);
  input.once("error", (error) => output.destroy(error));
  input.pipe(output);
  await finished(output);
}
async function splitArchive(file, options = {}) {
  const log = options.log ?? (() => {
  });
  const partBytes = Number.isSafeInteger(options.partBytes) ? Math.min(Math.max(options.partBytes, 1024 * 1024), MAX_PART_BYTES) : DEFAULT_PART_BYTES;
  const info = await stat5(file);
  if (!info.isFile()) throw new Error(`not a file: ${file}`);
  const dir = options.dir ?? await mkdtemp4(path11.join(tmpdir2(), "dsh-mesh-release-"));
  await mkdir7(dir, { recursive: true });
  const name = path11.basename(file);
  const count = Math.max(1, Math.ceil(info.size / partBytes));
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * partBytes;
    const end = Math.min(info.size, start + partBytes) - 1;
    const partName = `${name}.part${String(index + 1).padStart(3, "0")}`;
    const partPath = path11.join(dir, partName);
    await rm7(partPath, { force: true });
    await copyRange(file, partPath, start, end);
    const partInfo = await stat5(partPath);
    parts.push({ name: partName, path: partPath, bytes: partInfo.size });
    log(`split ${name}: ${partName} (${formatBytes(partInfo.size)})`);
  }
  return { file, dir, partBytes, parts };
}
async function removeSplit(dir) {
  await rm7(dir, { recursive: true, force: true }).catch(() => {
  });
}
function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 100 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)} ${units[unit]}`;
}
async function withRetry(run2, options = {}) {
  const retries = Number.isSafeInteger(options.retries) ? Math.max(0, options.retries) : 2;
  const log = options.log ?? (() => {
  });
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const delay = 1e3 * 2 ** (attempt - 1);
      log(`${options.label ?? "request"} retry ${String(attempt)}/${String(retries)} in ${String(delay)}ms (${lastError === null ? "" : lastError.message})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await run2();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.retryable !== true) throw lastError;
    }
  }
  throw lastError ?? new Error("request failed");
}
function retryable(error) {
  error.retryable = true;
  return error;
}
var GitHubRelease = class {
  /**
   * @param {{owner: string, repo: string, token: string}} options repository.
   * @param {{proxy?: string|null, log?: (line:string)=>void}} [options] options.
   */
  constructor(options, shared = {}) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.proxy = shared.proxy ?? null;
    this.log = shared.log ?? (() => {
    });
    this.apiBase = shared.apiBase ?? "https://api.github.com";
    this.uploadBase = shared.uploadBase ?? "https://uploads.github.com";
    this.webBase = shared.webBase ?? "https://github.com";
  }
  /** @returns {string} API root. */
  get apiRoot() {
    return `${this.apiBase}/repos/${this.owner}/${this.repo}`;
  }
  /** @returns {string} human-readable release page. */
  get htmlUrl() {
    return `${this.webBase}/${this.owner}/${this.repo}/releases/tag/${this.tag ?? DEFAULT_RELEASE_TAG}`;
  }
  /**
   * One API request.
   * @param {string} endpoint path below the repo root, or an absolute URL.
   * @param {{method?: string, json?: unknown, headers?: Record<string,string>}} [options] request.
   * @returns {Promise<{status:number, json:any, text:string, headers:object}>} response.
   */
  async #api(endpoint, options = {}) {
    const url = endpoint.startsWith("https://") ? endpoint : `${this.apiRoot}${endpoint}`;
    const response = await withRetry(async () => {
      const result = await requestJson(url, {
        method: options.method ?? (options.json === void 0 ? "GET" : "POST"),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...options.headers
        },
        json: options.json,
        proxy: this.proxy,
        timeoutMs: 6e4,
        idleTimeoutMs: 12e4
      });
      if (result.status === 429 || result.status >= 500) {
        throw retryable(new Error(`GitHub API ${options.method ?? "GET"} ${url} returned HTTP ${String(result.status)}: ${result.text.slice(0, 300)}`));
      }
      return result;
    }, { log: this.log, label: `github ${options.method ?? "GET"} ${url.replace(/^https:\/\/api\.github\.com/u, "")}` });
    return response;
  }
  /**
   * Find the rolling release or create it.
   * @param {string} tag release tag.
   * @param {{name?: string, body?: string}} [options] release metadata.
   * @returns {Promise<{id: number, tag_name: string, upload_url: string, assets: Array<object>}>} release.
   */
  async ensureRelease(tag, options = {}) {
    this.tag = tag;
    const found = await this.#api(`/releases/tags/${encodeURIComponent(tag)}`);
    if (found.status === 200 && found.json !== null) return await this.#releaseWithAssets(found.json);
    if (found.status !== 404) {
      throw new Error(`GitHub release lookup failed: HTTP ${String(found.status)} ${found.text.slice(0, 300)}`);
    }
    const created = await this.#api("/releases", {
      json: {
        tag_name: tag,
        name: options.name ?? `latest packages (${tag})`,
        body: options.body ?? "The newest dsh-mesh deployment packages. Older assets are replaced on every build.",
        draft: false,
        prerelease: false
      }
    });
    if (!isSuccess(created.status) || created.json === null) {
      throw new Error(`GitHub release creation failed: HTTP ${String(created.status)} ${created.text.slice(0, 300)}`);
    }
    return await this.#releaseWithAssets(created.json);
  }
  /**
   * Normalize a release object and include its assets.
   * @param {object} release API release.
   * @returns {Promise<object>} release with assets.
   */
  async #releaseWithAssets(release) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    return {
      id: release.id,
      tag_name: release.tag_name,
      html_url: release.html_url,
      assets: assets.map((asset) => ({ id: asset.id, name: asset.name, size: asset.size, url: asset.browser_download_url }))
    };
  }
  /**
   * Re-read the release's asset list.
   * @param {number} id release id.
   * @returns {Promise<Array<{id:number,name:string,size:number,url:string}>>} assets.
   */
  async listAssets(id) {
    const assets = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.#api(`/releases/${String(id)}/assets?per_page=100&page=${String(page)}`);
      if (!isSuccess(response.status) || !Array.isArray(response.json)) {
        throw new Error(`GitHub asset list failed: HTTP ${String(response.status)} ${response.text.slice(0, 300)}`);
      }
      for (const asset of response.json) {
        assets.push({ id: asset.id, name: asset.name, size: asset.size, url: asset.browser_download_url });
      }
      if (response.json.length < 100) break;
    }
    this.assetCache = assets;
    return assets;
  }
  /**
   * Upload one asset, replacing an asset with the same name.
   * @param {number} releaseId release id.
   * @param {string} file local file.
   * @param {(progress: object) => void} [onProgress] progress.
   * @returns {Promise<object>} uploaded asset.
   */
  async uploadAsset(releaseId, file, onProgress) {
    const name = path11.basename(file);
    const known = this.assetCache ?? await this.listAssets(releaseId);
    const existing = known.find((asset) => asset.name === name);
    if (existing !== void 0) await this.deleteAsset(existing.id);
    const url = `${this.uploadBase}/repos/${this.owner}/${this.repo}/releases/${String(releaseId)}/assets?name=${encodeURIComponent(name)}`;
    const result = await uploadFile(url, {
      file,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/octet-stream"
      },
      proxy: this.proxy,
      onProgress,
      retries: 2,
      log: this.log
    });
    if (result.status !== 201 && !isSuccess(result.status)) {
      throw new Error(`GitHub asset upload failed for ${name}: HTTP ${String(result.status)} ${result.text.slice(0, 300)}`);
    }
    this.assetCache = [...(this.assetCache ?? []).filter((asset) => asset.name !== name), { name, size: (await stat5(file)).size }];
    return result.json ?? {};
  }
  /**
   * Delete one asset.
   * @param {number} assetId asset id.
   * @returns {Promise<void>} done.
   */
  async deleteAsset(assetId) {
    const response = await this.#api(`/releases/assets/${String(assetId)}`, { method: "DELETE" });
    if (!isSuccess(response.status) && response.status !== 404) {
      throw retryable(new Error(`GitHub asset delete failed: HTTP ${String(response.status)} ${response.text.slice(0, 200)}`));
    }
    this.assetCache = this.assetCache?.filter((asset) => asset.id !== assetId);
  }
};
var GiteeRelease = class {
  /**
   * @param {{owner: string, repo: string, token: string, branch?: string}} options repository.
   * @param {{proxy?: string|null, log?: (line:string)=>void}} [options] options.
   */
  constructor(options, shared = {}) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.branch = options.branch ?? "main";
    this.proxy = null;
    this.log = shared.log ?? (() => {
    });
    this.apiBase = shared.apiBase ?? "https://gitee.com/api/v5";
    this.webBase = shared.webBase ?? "https://gitee.com";
  }
  /** @returns {string} API root. */
  get apiRoot() {
    return `${this.apiBase}/repos/${this.owner}/${this.repo}`;
  }
  /** @returns {string} human-readable release page. */
  get htmlUrl() {
    return `${this.webBase}/${this.owner}/${this.repo}/releases/tag/${this.tag ?? DEFAULT_RELEASE_TAG}`;
  }
  /**
   * One API request. The token travels in the query for GET/DELETE and in the
   * JSON body for writes.
   * @param {string} endpoint path below the repo root.
   * @param {{method?: string, json?: unknown, query?: Record<string,string>}} [options] request.
   * @returns {Promise<{status:number, json:any, text:string}>} response.
   */
  async #api(endpoint, options = {}) {
    const url = new URL(`${this.apiRoot}${endpoint}`);
    url.searchParams.set("access_token", this.token);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const method = options.method ?? (options.json === void 0 ? "GET" : "POST");
    const response = await withRetry(async () => {
      const result = await requestJson(url.href, {
        method,
        json: options.json === void 0 ? void 0 : { ...options.json, access_token: this.token },
        proxy: this.proxy,
        timeoutMs: 6e4,
        idleTimeoutMs: 18e4
      });
      if (result.status === 429 || result.status >= 500) {
        throw retryable(new Error(`Gitee API ${method} ${endpoint} returned HTTP ${String(result.status)}: ${result.text.slice(0, 300)}`));
      }
      return result;
    }, { log: this.log, label: `gitee ${method} ${endpoint}` });
    return response;
  }
  /**
   * Find the rolling release or create it.
   * @param {string} tag release tag.
   * @param {{name?: string, body?: string}} [options] release metadata.
   * @returns {Promise<{id:number, tag_name:string}>} release.
   */
  async ensureRelease(tag, options = {}) {
    this.tag = tag;
    const found = await this.#api(`/releases/tags/${encodeURIComponent(tag)}`);
    if (found.status === 200 && found.json !== null) {
      return { id: found.json.id, tag_name: found.json.tag_name, html_url: found.json.html_url };
    }
    if (found.status !== 404) {
      throw new Error(`Gitee release lookup failed: HTTP ${String(found.status)} ${found.text.slice(0, 300)}`);
    }
    const created = await this.#api("/releases", {
      json: {
        tag_name: tag,
        name: options.name ?? `latest packages (${tag})`,
        body: options.body ?? "The newest dsh-mesh deployment packages. Older assets are replaced on every build.",
        target_commitish: this.branch,
        prerelease: false
      }
    });
    if (!isSuccess(created.status) || created.json === null) {
      const detail = created.json?.message ?? created.text.slice(0, 300);
      const hint = /not found|404/iu.test(detail) ? "\uFF08Gitee \u4ED3\u5E93\u4E0D\u5B58\u5728\u6216 token \u65E0\u6743\u9650\uFF1A\u8BF7\u5148\u5728 Gitee \u521B\u5EFA\u516C\u5F00\u4ED3\u5E93\u5E76\u7ED9 token projects \u6743\u9650\uFF09" : "";
      throw new Error(`Gitee release creation failed: HTTP ${String(created.status)} ${detail}${hint}`);
    }
    return { id: created.json.id, tag_name: created.json.tag_name, html_url: created.json.html_url };
  }
  /**
   * List the release's attachments.
   * @param {number} releaseId release id.
   * @returns {Promise<Array<{id:number,name:string,size:number,url:string}>>} attachments.
   */
  async listAssets(releaseId) {
    const assets = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.#api(`/releases/${String(releaseId)}/attach_files`, {
        query: { page: String(page), per_page: "100" }
      });
      let list = Array.isArray(response.json) ? response.json : Array.isArray(response.json?.attach_files) ? response.json.attach_files : null;
      if (response.status === 404 && page === 1) {
        const release = await this.#api(`/releases/${String(releaseId)}`);
        list = Array.isArray(release.json?.attach_files) ? release.json.attach_files : null;
      }
      if (!isSuccess(response.status) && response.status !== 404) {
        throw new Error(`Gitee attachment list failed: HTTP ${String(response.status)} ${response.text.slice(0, 300)}`);
      }
      if (list === null) throw new Error(`Gitee attachment list failed: HTTP ${String(response.status)} ${response.text.slice(0, 300)}`);
      for (const file of list) {
        assets.push({
          id: file.id,
          name: file.name ?? file.file_name ?? "",
          size: file.size ?? 0,
          url: publicAssetUrl(file.browser_download_url ?? `${this.webBase}/${this.owner}/${this.repo}/releases/download/${this.tag ?? DEFAULT_RELEASE_TAG}/${encodeURIComponent(file.name ?? "")}`)
        });
      }
      if (list.length < 100) break;
    }
    this.assetCache = assets;
    return assets;
  }
  /**
   * Upload one attachment.
   * @param {number} releaseId release id.
   * @param {string} file local file.
   * @param {(progress: object) => void} [onProgress] progress.
   * @returns {Promise<{id:number,name:string,url:string}>} uploaded attachment.
   */
  async uploadAsset(releaseId, file, onProgress) {
    const name = path11.basename(file);
    const known = this.assetCache ?? await this.listAssets(releaseId);
    const existing = known.find((asset) => asset.name === name);
    if (existing !== void 0) await this.deleteAsset(releaseId, existing.id);
    const url = new URL(`${this.apiRoot}/releases/${String(releaseId)}/attach_files`);
    url.searchParams.set("access_token", this.token);
    const form = await multipartFileBody({ name, file });
    let lastError = null;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      if (attempt > 0) {
        const delay = 1e3 * 2 ** (attempt - 1);
        this.log(`gitee upload retry ${String(attempt)}/2 in ${String(delay)}ms (${lastError === null ? "" : lastError.message})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const body = attempt === 0 ? form : await multipartFileBody({ name, file });
      try {
        const response = await openResponse(url.href, {
          method: "POST",
          headers: { "content-type": body.contentType, "content-length": String(body.length) },
          body: body.body,
          length: body.length,
          proxy: this.proxy,
          timeoutMs: 6e4,
          idleTimeoutMs: 3e5,
          followRedirects: false
        });
        const text = await readText(response.stream, 512 * 1024);
        let json2 = null;
        try {
          json2 = text === "" ? null : JSON.parse(text);
        } catch {
          json2 = null;
        }
        if (isSuccess(response.statusCode) && json2 !== null) {
          onProgress?.({ bytes: body.length, totalBytes: body.length, percent: 100, speed: 0 });
          const asset = {
            id: json2.id,
            name: json2.name ?? name,
            url: publicAssetUrl(json2.browser_download_url ?? `${this.webBase}/${this.owner}/${this.repo}/releases/download/${this.tag ?? DEFAULT_RELEASE_TAG}/${encodeURIComponent(name)}`)
          };
          this.assetCache = [...(this.assetCache ?? []).filter((candidate) => candidate.name !== asset.name), asset];
          return asset;
        }
        const detail = json2?.message ?? text.slice(0, 300);
        lastError = new Error(`Gitee attachment upload failed for ${name}: HTTP ${String(response.statusCode)} ${detail}`);
        if (response.statusCode === 429 || response.statusCode >= 500) continue;
        throw lastError;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= 2) throw lastError;
      }
    }
    throw lastError ?? new Error(`Gitee attachment upload failed for ${name}`);
  }
  /**
   * Delete one attachment.
   * @param {number} releaseId release id.
   * @param {number} assetId attachment id.
   * @returns {Promise<void>} done.
   */
  async deleteAsset(releaseId, assetId) {
    const response = await this.#api(`/releases/${String(releaseId)}/attach_files/${String(assetId)}`, { method: "DELETE" });
    if (!isSuccess(response.status) && response.status !== 404) {
      throw retryable(new Error(`Gitee attachment delete failed: HTTP ${String(response.status)} ${response.text.slice(0, 200)}`));
    }
    this.assetCache = this.assetCache?.filter((asset) => asset.id !== assetId);
  }
};
function buildLatestManifest(options) {
  const { artifacts, config, partResults } = options;
  const first = artifacts[0]?.manifest ?? null;
  const assets = {};
  for (const artifact of artifacts) {
    const target = String(artifact.target ?? "");
    if (target === "") continue;
    const name = path11.basename(String(artifact.archive ?? ""));
    const parts = Array.isArray(partResults[target]) ? partResults[target] : [];
    const entry = {
      archive: name,
      bytes: Number(artifact.bytes ?? 0),
      sha256: artifact.sha256 ?? null,
      github: config.github?.enabled === true ? { url: releaseAssetUrl(config, "github", name), bytes: Number(artifact.bytes ?? 0) } : null,
      gitee: config.gitee?.enabled === true ? {
        partBytes: config.partBytes,
        parts: parts.map((part) => ({ name: part.name, bytes: part.bytes, sha256: part.sha256 ?? null })),
        urls: parts.map((part) => part.url ?? releaseAssetUrl(config, "gitee", part.name))
      } : null
    };
    assets[target] = entry;
  }
  return {
    format: 1,
    tag: config.tag,
    version: first?.version ?? null,
    buildStamp: first?.buildStamp ?? null,
    source: first?.source ?? null,
    ref: first?.ref ?? null,
    builtAt: first?.builtAt ?? null,
    publishedAt: options.publishedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    assets
  };
}
async function publishRelease(options) {
  const log = options.log ?? (() => {
  });
  const config = options.config;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const proxy2 = typeof options.proxy === "string" && options.proxy.trim() !== "" ? options.proxy.trim() : null;
  const artifacts = (Array.isArray(options.artifacts) ? options.artifacts : []).filter((artifact) => typeof artifact?.archive === "string" && artifact.archive !== "");
  if (config?.enabled !== true) {
    return { status: "skipped", reason: "release publishing is not configured", startedAt, finishedAt: (/* @__PURE__ */ new Date()).toISOString() };
  }
  if (artifacts.length === 0) {
    return { status: "skipped", reason: "build produced no archive", startedAt, finishedAt: (/* @__PURE__ */ new Date()).toISOString() };
  }
  const now = options.now ?? /* @__PURE__ */ new Date();
  const prepared = [];
  const splits = [];
  const result = {
    status: "running",
    startedAt,
    tag: config.tag,
    version: artifacts[0]?.manifest?.version ?? null,
    buildStamp: artifacts[0]?.manifest?.buildStamp ?? null,
    github: { enabled: config.github.enabled, status: config.github.enabled ? "pending" : "disabled", assets: [], removed: [] },
    gitee: { enabled: config.gitee.enabled, status: config.gitee.enabled ? "pending" : "disabled", assets: [], removed: [] },
    manifest: null
  };
  try {
    for (const artifact of artifacts) {
      const file = path11.resolve(artifact.archive);
      const info = await stat5(file);
      const digest = artifact.sha256 ?? await sha256File2(file);
      prepared.push({ ...artifact, archive: file, bytes: info.size, sha256: digest });
      log(`release asset ${path11.basename(file)} (${formatBytes(info.size)}, sha256 ${digest.slice(0, 12)}\u2026)`);
    }
    const partResults = {};
    if (config.gitee.enabled) {
      let total = 0;
      for (const artifact of prepared) {
        const split = await splitArchive(artifact.archive, { partBytes: config.partBytes, log });
        splits.push(split.dir);
        const parts = [];
        for (const part of split.parts) {
          total += part.bytes;
          parts.push({ ...part, sha256: await sha256File2(part.path) });
        }
        partResults[artifact.target] = parts;
        log(`gitee ${artifact.target}: ${String(parts.length)} part(s), ${formatBytes(parts.reduce((sum, part) => sum + part.bytes, 0))}`);
      }
      if (total > GITEE_REPO_QUOTA_BYTES) {
        result.gitee.warning = `\u672C\u6B21\u5206\u7247\u5171 ${formatBytes(total)}\uFF0C\u8D85\u8FC7 Gitee \u4ED3\u5E93\u9644\u4EF6\u9884\u7B97 ${formatBytes(GITEE_REPO_QUOTA_BYTES)}\uFF1B\u4E0A\u4F20\u53EF\u80FD\u56E0\u914D\u989D\u5931\u8D25`;
        log(`warning: ${result.gitee.warning}`);
      }
    }
    const manifest = buildLatestManifest({ artifacts: prepared, config, partResults, publishedAt: now.toISOString() });
    const manifestFile = path11.join(splits[0] ?? await mkdtemp4(path11.join(tmpdir2(), "dsh-mesh-release-")), LATEST_MANIFEST_NAME);
    if (splits.length === 0) splits.push(path11.dirname(manifestFile));
    await writeFile6(manifestFile, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    result.manifest = { ...manifest, assets: manifest.assets };
    if (config.github.enabled) {
      try {
        const github = new GitHubRelease(config.github, { proxy: proxy2, log, apiBase: config.github.apiBase, uploadBase: config.github.uploadBase, webBase: config.github.webBase });
        const release = await github.ensureRelease(config.tag, { name: `dsh-mesh ${manifest.version ?? ""} ${manifest.buildStamp ?? ""}`.trim() });
        result.github.releaseUrl = release.html_url ?? github.htmlUrl;
        for (const artifact of prepared) {
          const name = path11.basename(artifact.archive);
          log(`github upload ${name}`);
          let nextReport = 10;
          await github.uploadAsset(release.id, artifact.archive, (progress) => {
            const percent = Number(progress.percent ?? 0);
            if (percent < nextReport) return;
            nextReport = Math.min(100, percent + 10);
            log(`github upload ${name} ${String(percent)}%`);
          });
          result.github.assets.push({ name, bytes: artifact.bytes });
        }
        log(`github upload ${LATEST_MANIFEST_NAME}`);
        await github.uploadAsset(release.id, manifestFile);
        result.github.assets.push({ name: LATEST_MANIFEST_NAME, bytes: (await stat5(manifestFile)).size });
        const keep = new Set(result.github.assets.map((asset) => asset.name));
        for (const asset of await github.listAssets(release.id)) {
          if (keep.has(asset.name)) continue;
          log(`github remove old asset ${asset.name}`);
          await github.deleteAsset(asset.id);
          result.github.removed.push(asset.name);
        }
        result.github.status = "done";
      } catch (error) {
        result.github.status = "failed";
        result.github.error = error instanceof Error ? error.message : String(error);
        log(`github publish failed: ${result.github.error}`);
      }
    }
    if (config.gitee.enabled) {
      try {
        const gitee = new GiteeRelease(config.gitee, { proxy: proxy2, log, apiBase: config.gitee.apiBase, webBase: config.gitee.webBase });
        const release = await gitee.ensureRelease(config.tag, { name: `dsh-mesh ${manifest.version ?? ""} ${manifest.buildStamp ?? ""}`.trim() });
        result.gitee.releaseUrl = release.html_url ?? gitee.htmlUrl;
        const newNames = /* @__PURE__ */ new Set([LATEST_MANIFEST_NAME, ...Object.values(partResults).flat().map((part) => part.name)]);
        for (const asset of await gitee.listAssets(release.id)) {
          if (newNames.has(asset.name) || asset.name === LATEST_MANIFEST_NAME) continue;
          log(`gitee remove old asset ${asset.name}`);
          await gitee.deleteAsset(release.id, asset.id);
          result.gitee.removed.push(asset.name);
        }
        const uploaded = {};
        for (const artifact of prepared) {
          uploaded[artifact.target] = [];
          for (const part of partResults[artifact.target] ?? []) {
            log(`gitee upload ${part.name}`);
            let nextReport = 10;
            const response = await gitee.uploadAsset(release.id, part.path, (progress) => {
              const percent = Number(progress.percent ?? 0);
              if (percent < nextReport) return;
              nextReport = Math.min(100, percent + 10);
              log(`gitee upload ${part.name} ${String(percent)}%`);
            });
            const url = response.url ?? releaseAssetUrl(config, "gitee", part.name);
            uploaded[artifact.target].push({ ...part, url });
            result.gitee.assets.push({ name: part.name, bytes: part.bytes, url });
          }
        }
        const finalManifest = buildLatestManifest({ artifacts: prepared, config, partResults: uploaded, publishedAt: now.toISOString() });
        result.manifest = finalManifest;
        await writeFile6(manifestFile, `${JSON.stringify(finalManifest, null, 2)}
`, "utf8");
        log(`gitee upload ${LATEST_MANIFEST_NAME}`);
        await gitee.uploadAsset(release.id, manifestFile);
        result.gitee.assets.push({ name: LATEST_MANIFEST_NAME, bytes: (await stat5(manifestFile)).size });
        for (const asset of await gitee.listAssets(release.id)) {
          if (newNames.has(asset.name)) continue;
          log(`gitee remove old asset ${asset.name}`);
          await gitee.deleteAsset(release.id, asset.id);
          result.gitee.removed.push(asset.name);
        }
        result.gitee.status = "done";
        if (config.github.enabled && result.github.status === "done") {
          try {
            const github = new GitHubRelease(config.github, { proxy: proxy2, log, apiBase: config.github.apiBase, uploadBase: config.github.uploadBase, webBase: config.github.webBase });
            const releaseInfo = await github.ensureRelease(config.tag);
            log(`github refresh ${LATEST_MANIFEST_NAME} with the final Gitee URLs`);
            await github.uploadAsset(releaseInfo.id, manifestFile);
          } catch (error) {
            result.github.warning = `GitHub \u7684 ${LATEST_MANIFEST_NAME} \u672A\u80FD\u5237\u65B0\u4E3A Gitee \u5206\u7247\u5730\u5740\uFF1A${error instanceof Error ? error.message : String(error)}`;
            log(`warning: ${result.github.warning}`);
          }
        }
      } catch (error) {
        result.gitee.status = "failed";
        result.gitee.error = error instanceof Error ? error.message : String(error);
        log(`gitee publish failed: ${result.gitee.error}`);
      }
    }
    const states = [result.github.status, result.gitee.status].filter((state) => state !== "disabled");
    result.status = states.length === 0 ? "skipped" : states.every((state) => state === "done") ? "done" : states.some((state) => state === "done") ? "partial" : "failed";
    result.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    log(`release publish ${result.status} (tag ${config.tag})`);
    return result;
  } catch (error) {
    result.status = "failed";
    result.error = error instanceof Error ? error.message : String(error);
    result.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    log(`release publish failed: ${result.error}`);
    return result;
  } finally {
    for (const dir of splits) await removeSplit(dir);
  }
}

// code/build/job.mjs
function defaultJobRoot() {
  return path12.join(os6.homedir(), ".dsh", "mesh", "build");
}
function defaultCacheDir2() {
  return path12.join(os6.homedir(), ".dsh", "mesh", "cache");
}
async function createJob(options = {}) {
  const root = options.root ?? defaultJobRoot();
  const id = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`;
  const dir = path12.join(root, id);
  await mkdir8(dir, { recursive: true });
  const state = {
    id,
    dir,
    status: "created",
    phase: "created",
    source: options.source ?? DEFAULT_SOURCE,
    ref: options.ref ?? DEFAULT_REF,
    targets: options.targets ?? [...DEFAULT_TARGETS],
    // Immutable DSH version lives in `version`; this is the daily build
    // revision used in the package filename.
    buildStamp: options.buildStamp ?? null,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    // `member` is the build host (null = this machine); `proxy` is the outbound
    // proxy the downloads go through, so a job can be reproduced as it ran.
    member: options.member ?? null,
    proxy: options.proxy ?? null,
    mode: options.mode ?? "local",
    worktree: null,
    workOrder: null,
    artifacts: [],
    error: null,
    learnedAt: null
  };
  await writeState(dir, state);
  await appendLog(dir, "job created");
  return { id, dir, state };
}
async function readState(dir) {
  return JSON.parse(await readFile9(path12.join(dir, "state.json"), "utf8"));
}
async function writeState(dir, state) {
  const file = path12.join(dir, "state.json");
  const temporary = `${file}.tmp`;
  await writeFile7(temporary, JSON.stringify({ ...state, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), "utf8");
  await rename5(temporary, file);
}
async function appendLog(dir, line) {
  await appendFile2(path12.join(dir, "build.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, "utf8");
}
async function readLogTail(dir, lines = 80) {
  try {
    const text = await readFile9(path12.join(dir, "build.log"), "utf8");
    const trimmed = text.trimEnd();
    if (trimmed === "") return [];
    return trimmed.split(/\r?\n/u).slice(-lines);
  } catch {
    return [];
  }
}
async function updateState(dir, patch) {
  const state = { ...await readState(dir), ...patch };
  await writeState(dir, state);
  return state;
}
function unverifiedBuildReason(artifacts, options = {}) {
  if (options.full === false || options.smoke === false) return null;
  if (artifacts.some((artifact) => artifact.smoke?.status === "passed")) return null;
  const detail = artifacts.map((artifact) => `${artifact.target}: ${artifact.smoke?.status ?? "not run"}${artifact.smoke?.reason === void 0 ? "" : ` (${artifact.smoke.reason})`}`).join("; ");
  return `no target was booted in a browser (${detail}). Install Chrome/Chromium/Edge or set DSH_MESH_SMOKE_CHROME, build on a host that can run at least one target, or pass --no-smoke to accept an unverified package explicitly.`;
}
async function runJob(dir, options) {
  const repositoryRoot = options.repositoryRoot;
  const recipesPath = options.recipesPath ?? path12.join(repositoryRoot, "build", "recipes.json");
  const overlayRoot = options.overlayRoot ?? path12.join(repositoryRoot, "build", "overlays");
  const outbound = proxyFor({ proxy: options.proxy, env: options.env, fetchImpl: options.fetchImpl });
  let state = await readState(dir);
  const buildStamp = options.buildStamp ?? state.buildStamp ?? `${buildStampDate()}A`;
  if (!isValidBuildStamp(buildStamp)) throw new Error(`invalid build stamp: ${String(buildStamp)}`);
  if (state.buildStamp !== buildStamp) state = await updateState(dir, { buildStamp });
  const log = (line) => {
    void appendLog(dir, line);
    options.onLog?.(line);
  };
  try {
    state = await updateState(dir, { status: "running", phase: "prepare", percent: 2, currentTarget: null, error: null });
    const prepared = options.reuseWorktree === true && existsSync6(path12.join(dir, "src")) ? { dir: path12.join(dir, "src"), source: state.source, ref: state.ref, local: false, archiveSha256: state.archiveSha256 ?? null } : await prepareSource({
      source: state.source,
      ref: state.ref,
      cacheDir: options.cacheDir ?? defaultCacheDir2(),
      workDir: dir,
      fetchImpl: outbound.fetchImpl,
      log
    });
    state = await updateState(dir, {
      phase: "apply",
      percent: 7,
      proxy: outbound.proxy,
      source: prepared.source,
      ref: prepared.ref,
      worktree: prepared.dir,
      archiveSha256: prepared.archiveSha256 ?? null,
      archiveEtag: prepared.archiveEtag ?? null
    });
    const recipes = await loadRecipes(recipesPath);
    const result = await applyRecipes({ dir: prepared.dir, recipes, overlayRoot, log });
    if (!result.ok) {
      const order = await writeWorkOrder({
        dir: path12.join(dir, "work-order"),
        jobDir: dir,
        source: state.source,
        ref: state.ref,
        recipes,
        result,
        worktree: prepared.dir
      });
      state = await updateState(dir, {
        status: "needs-fix",
        phase: "apply",
        percent: 14,
        workOrder: order,
        mismatches: result.mismatches,
        applied: result.applied,
        skipped: result.skipped
      });
      log(`needs-fix: ${String(result.mismatches.length)} overlay(s) no longer match`);
      return state;
    }
    if (options.planOnly === true) {
      state = await updateState(dir, {
        status: "planned",
        phase: "apply",
        percent: 100,
        applied: result.applied,
        skipped: result.skipped,
        mismatchCount: 0
      });
      log("plan complete: every overlay applies");
      return state;
    }
    state = await updateState(dir, {
      phase: "build",
      percent: 12,
      applied: result.applied,
      skipped: result.skipped
    });
    const built = await runWebBuild({
      dir: prepared.dir,
      log,
      install: options.install,
      build: options.build,
      prepare: options.prepare ?? (Array.isArray(recipes.prepare) ? recipes.prepare : null),
      env: outbound.env,
      prebuild: options.prebuild,
      // The install and the web build are the two long silent steps; the
      // panel would otherwise sit at 12% until packaging starts.
      onProgress: async (update) => {
        state = await updateState(dir, { phase: update.phase, percent: update.percent });
      }
    });
    if (!built.ok) {
      state = await updateState(dir, { status: "build-failed", phase: "build", error: built.error ?? "web build failed" });
      log(`build failed: ${built.error ?? "unknown error"}`);
      return state;
    }
    const version = options.version ?? await readSourceVersion(prepared.dir);
    const pluginVersion = await readPluginVersion(repositoryRoot);
    const fingerprint = await pluginFingerprint(repositoryRoot);
    state = await updateState(dir, {
      phase: "package",
      percent: 65,
      version,
      pluginVersion,
      pluginFingerprint: fingerprint,
      dist: built.dist
    });
    const artifacts = [];
    const full = options.full !== false;
    const targets = state.targets;
    for (const target of targets) {
      state = await updateState(dir, {
        phase: "package",
        percent: targetPercent(targets, target, "start"),
        currentTarget: target
      });
      const shared = {
        dist: built.dist,
        target,
        outputDir: path12.join(dir, "dist"),
        version,
        buildStamp,
        repositoryRoot,
        source: state.source,
        ref: state.ref,
        tree: recipes.tree ?? null,
        sourceEtag: state.archiveEtag ?? null,
        pluginVersion,
        pluginFingerprint: fingerprint,
        fetchImpl: outbound.fetchImpl,
        env: outbound.env,
        cacheDir: options.cacheDir ?? defaultCacheDir2(),
        log
      };
      const assembled = full ? await assembleRuntimePackage({
        ...shared,
        dshVersion: version,
        nodeVersion: options.nodeVersion ?? process.versions.node,
        cacheDir: options.cacheDir ?? defaultCacheDir2()
      }) : await assembleWebPackage(shared);
      const archive = await archivePackage(assembled.packageDir, target, { log });
      const info = await stat6(archive);
      let smoke = null;
      if (options.smoke === false) {
        smoke = { ok: true, status: "skipped", reason: "smoke test disabled for this build", checks: [], screenshots: [] };
      } else if (!full) {
        smoke = { ok: true, status: "skipped", reason: "web-only package has no app/runtime to start", checks: [], screenshots: [] };
      } else {
        state = await updateState(dir, {
          phase: "smoke",
          percent: targetPercent(targets, target, "smoke"),
          currentTarget: target
        });
        log(`smoke ${target}: starting the packaged DSH under headless Chrome`);
        smoke = await runPackageSmoke({
          packageRoot: assembled.packageDir,
          target,
          workDir: path12.join(dir, "smoke", target),
          screenshotDir: path12.join(dir, "smoke", target),
          chrome: options.smokeChrome,
          required: options.smokeRequired === true,
          startTimeoutMs: options.smokeStartTimeoutMs,
          pageTimeoutMs: options.smokePageTimeoutMs,
          log
        });
        if (smoke.status === "skipped") log(`smoke ${target}: skipped (${smoke.reason})`);
        else log(`smoke ${target}: ${smoke.status}${Array.isArray(smoke.screenshots) && smoke.screenshots.length > 0 ? ` (${smoke.screenshots.join(", ")})` : ""}`);
      }
      const artifact = {
        target,
        packageDir: assembled.packageDir,
        archive,
        bytes: info.size,
        manifest: assembled.manifest,
        smoke
      };
      artifacts.push(artifact);
      log(`packaged ${target}: ${archive}`);
      if (smoke?.status === "failed") {
        state = await updateState(dir, {
          status: "smoke-failed",
          phase: "smoke",
          percent: targetPercent(targets, target, "end"),
          error: `${target} smoke test failed: ${smoke.error ?? "see smoke.log"}`,
          artifacts
        });
        log(`smoke ${target}: failed; stopping before the next target`);
        return state;
      }
      state = await updateState(dir, {
        phase: "package",
        percent: targetPercent(targets, target, "end"),
        currentTarget: target,
        artifacts
      });
    }
    const unverified = unverifiedBuildReason(artifacts, { full, smoke: options.smoke });
    if (unverified !== null) {
      state = await updateState(dir, {
        status: "smoke-failed",
        phase: "smoke",
        percent: 95,
        error: unverified,
        artifacts
      });
      log(`smoke verification incomplete: ${unverified}`);
      return state;
    }
    state = await updateState(dir, { status: "done", phase: "publish", percent: 98, currentTarget: null, artifacts });
    if (options.publish === false || options.publish === null || options.publish === void 0) {
      log("release publish skipped (disabled)");
      state = await updateState(dir, {
        phase: "done",
        percent: 100,
        publish: { status: "skipped", reason: "release publishing is disabled for this build" }
      });
      log("build complete");
      return state;
    }
    if (full === false) {
      log("release publish skipped (web-only package has no app/runtime)");
      state = await updateState(dir, {
        phase: "done",
        percent: 100,
        publish: { status: "skipped", reason: "web-only packages are not published as deployment packages" }
      });
      log("build complete");
      return state;
    }
    try {
      const publish = await publishRelease({
        artifacts,
        config: options.publish.config,
        proxy: typeof options.publish.proxy === "string" ? options.publish.proxy : null,
        log
      });
      state = await updateState(dir, { phase: "done", percent: 100, publish });
      log(`build complete (release publish ${publish.status})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = await updateState(dir, {
        phase: "done",
        percent: 100,
        publish: { status: "failed", error: message }
      });
      log(`release publish failed: ${message}`);
      log("build complete");
    }
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed: ${message}`);
    state = await updateState(dir, { status: "failed", phase: "failed", error: message });
    return state;
  }
}
async function learnJob(dir, options) {
  const recipesPath = options.recipesPath ?? path12.join(options.repositoryRoot, "build", "recipes.json");
  const overlayRoot = options.overlayRoot ?? path12.join(options.repositoryRoot, "build", "overlays");
  const state = await readState(dir);
  if (state.worktree === null) throw new Error("this job has no worktree yet");
  const recipes = await loadRecipes(recipesPath);
  const learned = await learnOverlays({
    worktree: state.worktree,
    recipes,
    overlayRoot,
    mismatches: Array.isArray(state.mismatches) ? state.mismatches : []
  });
  await writeFile7(recipesPath, JSON.stringify(learned.recipes, null, 2), "utf8");
  await appendLog(dir, `learned ${String(learned.learned.length)} overlay(s)`);
  return updateState(dir, { status: "learned", learnedAt: (/* @__PURE__ */ new Date()).toISOString(), learned: learned.learned });
}
async function readPluginVersion(repositoryRoot) {
  try {
    const parsed = JSON.parse(await readFile9(path12.join(repositoryRoot, "package.json"), "utf8"));
    return typeof parsed?.version === "string" && parsed.version.trim() !== "" ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}
async function readSourceVersion(worktree) {
  for (const candidate of [
    path12.join(worktree, "apps", "cli", "package.json"),
    path12.join(worktree, "package.json")
  ]) {
    try {
      const pkg = JSON.parse(await readFile9(candidate, "utf8"));
      if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
    } catch {
    }
  }
  return "0.0.0";
}

// code/deploy/engine.mjs
import { createHash as createHash3 } from "node:crypto";
import { createReadStream as createReadStream4 } from "node:fs";
import { spawn as spawn5 } from "node:child_process";
import { existsSync as existsSync8, readFileSync as readFileSync2 } from "node:fs";
import { copyFile as copyFile2, link, mkdir as mkdir9, mkdtemp as mkdtemp5, readFile as readFile11, readdir as readdir5, rename as rename6, rm as rm9, stat as stat8, writeFile as writeFile8 } from "node:fs/promises";
import { isIP as isIP3 } from "node:net";
import { homedir as homedir2, hostname, tmpdir as tmpdir3 } from "node:os";
import path14 from "node:path";

// code/shared/egress.mjs
import { spawn as spawn4 } from "node:child_process";
import { existsSync as existsSync7 } from "node:fs";
import { readFile as readFile10, stat as stat7 } from "node:fs/promises";
import path13 from "node:path";
import { fileURLToPath } from "node:url";
var HERE = path13.dirname(fileURLToPath(import.meta.url));
function resolveEgressScript(start) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path13.join(current, "code", "shared", "egress-proxy.mjs");
    if (existsSync7(candidate)) return candidate;
    const parent = path13.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path13.resolve(start, "..", "..", "code", "shared", "egress-proxy.mjs");
}
var SCRIPT_PATH = resolveEgressScript(HERE);
var REMOTE_SCRIPT = "$HOME/.dsh/mesh/egress-proxy.mjs";
var LISTEN_TIMEOUT_MS = 2e4;
function nodeCandidates(appRoot) {
  const root = String(appRoot ?? "").trim().replace(/[\\/]+$/u, "");
  return [
    "$HOME/.dsh/dsh-mesh/current/runtime/node/bin/node",
    "$HOME/.dsh/dsh-person-web/runtime/node/bin/node",
    ...root === "" ? [] : [`${root}/runtime/node/bin/node`],
    "/usr/local/bin/node",
    "/usr/bin/node"
  ];
}
function sshOptions(plan) {
  const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-p", String(plan.port ?? 22)];
  if (typeof plan.identityFile === "string" && plan.identityFile !== "") args.push("-i", plan.identityFile);
  return args;
}
function sshRun(plan, command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn4("ssh", [...sshOptions(plan), targetOf(plan), command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ stdout, stderr, code }));
    if (input !== void 0) child.stdin.end(input);
    else child.stdin.end();
  });
}
function targetOf(plan) {
  return plan.user === void 0 || plan.user === null || plan.user === "" ? plan.host : `${plan.user}@${plan.host}`;
}
var EgressProxy = class {
  /**
   * @param {{log?: (line: string) => void}} [options] options.
   */
  constructor(options = {}) {
    this.log = options.log ?? (() => {
    });
    this.live = /* @__PURE__ */ new Set();
  }
  /** Stop every proxy this manager started. */
  closeAll() {
    for (const entry of [...this.live]) entry.close();
    this.live.clear();
  }
  /**
   * Start a proxy on one member.
   * @param {{plan: {host: string, user?: string|null, port?: number, identityFile?: string|null, appRoot?: string}, member?: string}} options target.
   * @returns {Promise<{url: string, member: string, close: () => void}>} running proxy.
   */
  async start(options) {
    const plan = { port: 22, ...options.plan };
    if (plan.host === void 0 || plan.host === "") throw new Error("egress proxy needs a member address");
    await this.#install(plan);
    if (!/^[0-9a-f.:]+$/iu.test(plan.host)) throw new Error(`member address is not an IP: ${plan.host}`);
    const candidates = ['"$(command -v node 2>/dev/null || true)"', ...nodeCandidates(plan.appRoot).map((value) => `"${value}"`)];
    const command = [
      'mkdir -p "$HOME/.dsh/mesh"',
      "for candidate in \\",
      ...candidates.map((value) => `  ${value} \\`),
      "  ; do",
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then',
      `    exec "$candidate" "$HOME/.dsh/mesh/egress-proxy.mjs" "${plan.host}" 0`,
      "  fi",
      "done",
      'echo "no node runtime on this member" >&2',
      "exit 3",
      ""
    ].join("\n");
    const child = spawn4("ssh", [...sshOptions(plan), targetOf(plan), "bash -s"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdin.end(command);
    const url = await this.#waitForListen(child, plan.host);
    const entry = {
      url,
      close: () => {
        this.live.delete(entry);
        try {
          child.kill("SIGTERM");
        } catch {
        }
      }
    };
    this.live.add(entry);
    this.log(`egress proxy for ${plan.host} is ${url}`);
    return { ...entry, member: String(options.member ?? plan.host) };
  }
  /**
   * Copy the current proxy script to the member when it is missing or stale.
   * @param {object} plan member plan.
   * @returns {Promise<void>}
   */
  async #install(plan) {
    const local = await readFile10(SCRIPT_PATH, "utf8");
    const info = await stat7(SCRIPT_PATH);
    const stamp = `${String(info.size)}-${String(info.mtimeMs)}`;
    const check = await sshRun(plan, `test -f ${REMOTE_SCRIPT} && cat ${REMOTE_SCRIPT}`).catch(() => ({ stdout: "" }));
    if (check.stdout === local) return;
    this.log(`uploading egress proxy to ${plan.host} (${stamp})`);
    await sshRun(plan, `mkdir -p "$HOME/.dsh/mesh" && cat > ${REMOTE_SCRIPT}`, local);
  }
  /**
   * Wait for the proxy's LISTEN line or an early exit.
   * @param {import('node:child_process').ChildProcess} child ssh process.
   * @param {string} host member address.
   * @returns {Promise<string>} proxy URL.
   */
  #waitForListen(child, host) {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let errors = "";
      const timer = setTimeout(() => {
        cleanup();
        try {
          child.kill("SIGTERM");
        } catch {
        }
        reject(new Error(`egress proxy on ${host} did not report its port within ${String(LISTEN_TIMEOUT_MS)}ms
${errors.trim()}`));
      }, LISTEN_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off("data", onOut);
        child.stderr?.off("data", onErr);
        child.off("exit", onExit);
      };
      const onOut = (chunk) => {
        buffer += String(chunk);
        const match = /LISTEN (\d+)/u.exec(buffer);
        if (match === null) return;
        cleanup();
        resolve(`http://${host}:${match[1]}`);
      };
      const onErr = (chunk) => {
        errors += String(chunk);
      };
      const onExit = (code) => {
        cleanup();
        reject(new Error(`egress proxy on ${host} exited with ${String(code)}
${errors.trim()}`));
      };
      child.stdout?.on("data", onOut);
      child.stderr?.on("data", onErr);
      child.once("exit", onExit);
    });
  }
};

// code/deploy/engine.mjs
var EXTRACT_CHECKPOINT = 1e3;
var DEFAULT_APP_ROOT = {
  linux: "/opt/dsh-mesh",
  windows: "C:\\dsh-mesh"
};
var DEFAULT_SERVICES = {
  linux: [
    // The package's start.sh runs the gate, which spawns the private DSH; the
    // split services belong to the hand-installed layout, not to a package.
    { name: "dsh-web-gate.service", role: "gate", command: "start.sh" }
  ],
  windows: [
    // The supervisor service owns the whole stack: it runs start-stack.ps1
    // (gate + interop) in the interactive session when it can, and in session 0
    // otherwise. The old split DSH-Web-App service duplicated the gate's own
    // DSH spawn and is removed by the deploy.
    { name: "DSH-Mesh", role: "gate", command: "dsh-mesh-service.exe" }
  ]
};
var ROLE_ORDER = { control: 0, dsh: 1, gate: 2 };
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function ps(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
function psReplacement(value) {
  return ps(String(value).replace(/\$/g, "$$$$"));
}
function sedReplacement(value) {
  return String(value).replace(/[\\|&]/g, (match) => `\\${match}`);
}
var PROFILE_WIRE_SCRIPT = `
import fs from 'node:fs'
import path from 'node:path'
const [profileDir, pluginDir] = process.argv.slice(2)
if (typeof profileDir !== 'string' || profileDir === '' || typeof pluginDir !== 'string' || pluginDir === '') {
  console.error('profile-wire: expected <profileDir> <pluginDir>')
  process.exit(2)
}
if (!fs.existsSync(pluginDir)) {
  console.log('profile-wire: the release has no plugins/dsh-mesh; profile left untouched')
  process.exit(0)
}
const manifestFile = path.join(profileDir, 'package.json')
let manifest = {
  name: 'dsh-profile-' + path.basename(profileDir),
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}
if (fs.existsSync(manifestFile)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch {
    console.error('profile-wire: ' + manifestFile + ' is not valid JSON; left untouched')
    process.exit(1)
  }
}
manifest.dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!bundles.includes('@local/dsh-mesh')) bundles.push('@local/dsh-mesh')
manifest.dsh.profile.bundles = bundles
manifest.dependencies['@local/dsh-mesh'] = 'link:./node_modules/@local/dsh-mesh'
const target = path.join(profileDir, 'node_modules', '@local', 'dsh-mesh')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.rmSync(target, { recursive: true, force: true })
fs.cpSync(pluginDir, target, { recursive: true })
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\\n')
console.log('profile-wire: dsh loads @local/dsh-mesh from ' + target)

// Every other plugin shipped next to dsh-mesh (today: xl) is wired the same
// way: copy it into the profile, link the dependency, and add its bundle when
// the package declares one. Skipping this would leave the files in the release
// without DSH ever loading them.
const pluginsRoot = path.dirname(pluginDir)
const wired = new Set()
for (const entry of fs.readdirSync(pluginsRoot).sort()) {
  if (entry === path.basename(pluginDir)) continue
  // Backup copies (dsh-mesh.bak-20261111-1541) keep the original package
  // name; wiring one would load stale code instead of the release.
  if (entry.startsWith('.') || /[.~_]/u.test(entry)) continue
  const dir = path.join(pluginsRoot, entry)
  const manifestPath = path.join(dir, 'package.json')
  if (!fs.existsSync(manifestPath)) continue
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    console.error('profile-wire: ' + manifestPath + ' is not valid JSON; skipped')
    continue
  }
  const name = typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : entry
  if (path.basename(name) !== entry || wired.has(name)) continue
  wired.add(name)
  const parts = name.split('/')
  const linkTarget = path.join(profileDir, 'node_modules', ...parts)
  fs.mkdirSync(path.dirname(linkTarget), { recursive: true })
  fs.rmSync(linkTarget, { recursive: true, force: true })
  fs.cpSync(dir, linkTarget, { recursive: true })
  manifest.dependencies[name] = 'link:./node_modules/' + name
  const isBundle = pkg.dsh && typeof pkg.dsh === 'object' && pkg.dsh.bundle
  if (isBundle && !bundles.includes(name)) bundles.push(name)
  console.log('profile-wire: dsh loads ' + name + ' from ' + linkTarget)
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\\n')

// The member inherits the deployer's account grants, but a fresh profile still
// defaults to the API-key route and then fails with MISSING_CREDENTIAL. Point
// its default model at the same provider route the deployer uses.
const [providerArg, modelArg, effortArg] = process.argv.slice(4)
if (typeof providerArg === 'string' && providerArg !== '') {
  const pairs = [['provider', providerArg], ['model', modelArg || ''], ['reasoningEffort', effortArg || '']]
    .filter(pair => pair[1] !== '')
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const before = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
  const after = mergeModelRoute(before, pairs)
  fs.writeFileSync(patchFile, after)
  console.log('profile-wire: agent-default-model ' + pairs.map(pair => pair[0] + '=' + pair[1]).join(' '))
}

function mergeModelRoute(text, pairs) {
  const trailing = text === '' || text.endsWith('\\n') ? '' : '\\n'
  const lines = text.split('\\n')
  const scalar = value => (/^[A-Za-z0-9._-]+$/.test(value) ? value : JSON.stringify(value))
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '- id: agent-default-model') {
      start = index
      break
    }
  }
  if (start === -1) {
    const block = ['- id: agent-default-model', '  name: "@deepseek-ai/dsh-agent-default-model"', '  config:']
    for (const [key, value] of pairs) block.push('    ' + key + ': ' + scalar(value))
    const body = lines.filter(line => line !== '').join('\\n')
    return (body === '' ? '' : body + '\\n') + block.join('\\n') + '\\n'
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('- ')) {
      end = index
      break
    }
  }
  const block = lines.slice(start, end)
  let configAt = -1
  for (let index = 0; index < block.length; index += 1) {
    if (block[index].trim() === 'config:') {
      configAt = index
      break
    }
  }
  if (configAt === -1) {
    block.push('  config:')
    configAt = block.length - 1
  }
  for (const [key, value] of pairs) {
    const at = block.findIndex(line => line.startsWith('    ' + key + ':'))
    if (at !== -1) {
      block[at] = '    ' + key + ': ' + scalar(value)
      continue
    }
    // Append after the last existing key so the block keeps a natural order.
    let insertAt = configAt + 1
    for (let index = block.length - 1; index > configAt; index -= 1) {
      if (block[index].startsWith('    ') && block[index].trim() !== '') {
        insertAt = index + 1
        break
      }
    }
    block.splice(insertAt, 0, '    ' + key + ': ' + scalar(value))
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\\n') + trailing
}
`;
function deployerModelRoute() {
  if (process.env.DSH_DEPLOY_SYNC_MODEL === "0") return null;
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path14.join(homedir2(), ".dsh");
  const file = path14.join(home, "profiles", "web", "cordis.patch.yml");
  if (!existsSync8(file)) return null;
  let text;
  try {
    text = readFileSync2(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^- id:\s*agent-default-model\s*$/u.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^- /u.test(lines[index])) {
      end = index;
      break;
    }
  }
  const block = lines.slice(start, end);
  const read = (key) => {
    const line = block.find((candidate) => new RegExp(`^\\s+${key}:`, "u").test(candidate));
    if (line === void 0) return void 0;
    let value = line.slice(line.indexOf(":") + 1).trim();
    const hash = value.indexOf(" #");
    if (hash !== -1) value = value.slice(0, hash).trim();
    value = value.replace(/^(["'])(.*)\1$/u, "$2");
    return value === "" ? void 0 : value;
  };
  const provider = read("provider");
  if (provider === void 0) return null;
  return { provider, model: read("model"), reasoningEffort: read("reasoningEffort") };
}
function deployerCredentialsFile() {
  if (process.env.DSH_DEPLOY_SHARE_ACCOUNT === "0") return null;
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path14.join(homedir2(), ".dsh");
  const file = path14.join(home, ".credentials.yaml");
  return existsSync8(file) ? file : null;
}
function formatBytes2(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? String(Math.round(amount)) : amount.toFixed(1)} ${units[unit]}`;
}
function describeDeployFailure(message) {
  const text = String(message ?? "");
  if (!/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/iu.test(text)) return text;
  return `${text}

SSH \u4E3B\u673A\u5BC6\u94A5\u4E0E known_hosts \u4E2D\u7684\u8BB0\u5F55\u4E0D\u4E00\u81F4\uFF1A\u76EE\u6807\u673A\u53EF\u80FD\u91CD\u88C5\u8FC7\u7CFB\u7EDF\uFF0C\u6216\u8FD9\u4E2A VPN \u5730\u5740\u5DF2\u7ECF\u5C5E\u4E8E\u53E6\u4E00\u53F0\u673A\u5668\u3002\u8BF7\u5728 WireGuard \u9762\u677F\u5BF9\u8BE5\u6210\u5458\u91CD\u65B0\u6267\u884C\u4E00\u6B21\u300CSSH \u6388\u6743\u300D\uFF08\u751F\u6210\u547D\u4EE4\u65F6\u4F1A\u540C\u65F6\u5237\u65B0\u672C\u673A known_hosts\uFF09\uFF0C\u6216\u8005\u624B\u52A8\u6267\u884C ssh-keygen -R <\u76EE\u6807\u5730\u5740> \u540E\u91CD\u8BD5\u3002`;
}
function initialDeploySteps(options = {}) {
  const steps = [
    { key: "upload", label: "\u83B7\u53D6\u5B89\u88C5\u5305", status: "pending", startedAt: null, finishedAt: null, detail: "", progress: null }
  ];
  if (options.test === true && options.os !== "windows") {
    steps.push({ key: "rehearse", label: "\u5E73\u94FA\u6D41\u7A0B\u6F14\u7EC3\uFF08\u6C99\u7BB1\uFF09", status: "pending", startedAt: null, finishedAt: null, detail: "", progress: null });
  }
  steps.push({ key: "prepare", label: "\u89E3\u538B\u5E76\u51C6\u5907\u65B0\u7248\u672C", status: "pending", startedAt: null, finishedAt: null, detail: "", progress: null });
  steps.push({ key: "activate", label: "\u5207\u6362\u5E76\u91CD\u542F\u670D\u52A1", status: "pending", startedAt: null, finishedAt: null, detail: "", progress: null });
  return steps;
}
var RUNNER_START_GRACE_MS = 45e3;
var RUNNER_STALE_MS = 12e4;
function newJobId() {
  return `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
function jobPaths(dir) {
  return {
    dir,
    state: path14.join(dir, "job.json"),
    log: path14.join(dir, "deploy.log"),
    runner: path14.join(dir, "runner.json"),
    request: path14.join(dir, "request.json")
  };
}
async function writeDeployState(dir, state) {
  const file = path14.join(dir, "job.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir9(dir, { recursive: true });
  await writeFile8(tmp, `${JSON.stringify(state, null, 2)}
`, "utf8");
  await rename6(tmp, file);
}
async function appendDeployLog(dir, line) {
  await mkdir9(dir, { recursive: true });
  await writeFile8(path14.join(dir, "deploy.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}
`, { encoding: "utf8", flag: "a" });
}
async function runnerStatus(dir) {
  const file = path14.join(dir, "runner.json");
  let runner = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      runner = JSON.parse(await readFile11(file, "utf8"));
      break;
    } catch {
      runner = null;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (runner === null || typeof runner !== "object") return { alive: false, runner: null };
  const pid = Number(runner.pid);
  if (runner.host === hostname() && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return { alive: true, runner };
    } catch (error) {
      return { alive: error?.code === "EPERM", runner };
    }
  }
  const beat = Date.parse(String(runner.heartbeatAt ?? runner.startedAt ?? ""));
  if (Number.isFinite(beat) && Date.now() - beat < RUNNER_STALE_MS) return { alive: true, runner };
  return { alive: false, runner };
}
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash3("sha256");
    const stream = createReadStream4(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
function normalizeOs(value) {
  const text = String(value ?? "").toLowerCase();
  if (text === "linux" || text === "win" || text === "windows") {
    return text.startsWith("win") ? "windows" : "linux";
  }
  throw new Error('os must be "linux" or "windows"');
}
function normalizeInstallRoot(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return "";
  return text.replace(/[\\/]+current$/iu, "").replace(/[\\/]+$/u, "");
}
function inferRole(name) {
  const text = String(name).toLowerCase();
  if (text.includes("wireguard") || text.includes("wg-") || text.includes("control")) return "control";
  if (text.includes("gate")) return "gate";
  return "dsh";
}
function normalizeServices(input, os9) {
  const source = input === void 0 ? DEFAULT_SERVICES[os9] : input;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error("at least one service is required");
  }
  const seen = /* @__PURE__ */ new Set();
  const services = source.map((entry, index) => {
    const raw = typeof entry === "string" ? { name: entry } : entry;
    if (raw === null || typeof raw !== "object" || typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new Error(`service #${String(index + 1)} needs a name`);
    }
    const name = raw.name.trim();
    if (seen.has(name)) throw new Error(`duplicate service ${name}`);
    seen.add(name);
    const role = raw.role ?? inferRole(name);
    if (!(role in ROLE_ORDER)) throw new Error(`service ${name} has unknown role ${String(role)}`);
    const command = typeof raw.command === "string" && raw.command.trim() !== "" ? raw.command.trim() : os9 === "linux" ? "start.sh" : "dsh-mesh-service.exe";
    return { name, role, command };
  });
  if (!services.some((service) => service.role === "gate")) {
    throw new Error('the service list must include one gateway service (role "gate")');
  }
  if (services.filter((service) => service.role === "gate").length > 1) {
    throw new Error("the service list must include exactly one gateway service");
  }
  services.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  if (services[services.length - 1].role !== "gate") {
    throw new Error("the gateway must be the last service to restart");
  }
  return services;
}
async function findLatestPackage(repositoryRoot, os9) {
  const dist = path14.join(repositoryRoot, "dist");
  const suffix = os9 === "linux" ? ".tar.gz" : ".zip";
  const prefix = `dsh-mesh-`;
  const marker = `-${os9 === "linux" ? "linux" : "win"}-x64`;
  const entries = await readdir5(dist).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix) || !entry.includes(marker)) continue;
    const file = path14.join(dist, entry);
    const info = await stat8(file).catch(() => null);
    if (info?.isFile()) candidates.push({ file, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`no ${os9} package found in ${dist}; build one or pass --package`);
  }
  return candidates[0].file;
}
async function buildDeployPlan(options) {
  if (typeof options.host !== "string" || options.host.trim() === "") throw new Error("host is required");
  const os9 = normalizeOs(options.os ?? "linux");
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  let packagePath = "";
  let packageInfo2 = null;
  let sha256 = "";
  if (options.skipPackage !== true) {
    packagePath = options.package ? path14.resolve(options.package) : await findLatestPackage(repositoryRoot, os9);
    packageInfo2 = await stat8(packagePath);
    if (!packageInfo2.isFile()) throw new Error(`package is not a file: ${packagePath}`);
    sha256 = await hashFile(packagePath);
  }
  const release = options.skipPackage === true ? "rollback" : typeof options.release === "string" && options.release.trim() !== "" ? options.release.trim() : `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${sha256.slice(0, 8)}`;
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(release)) {
    throw new Error("release must be 3-80 chars of letters, digits, dot, underscore or dash");
  }
  const appRoot = normalizeInstallRoot(options.appRoot) || DEFAULT_APP_ROOT[os9];
  const services = normalizeServices(options.services, os9);
  const scope = options.scope === "dsh" ? "dsh" : "all";
  const gatePort = String(options.gatePort ?? "80");
  if (!/^\d{1,5}$/.test(gatePort) || Number(gatePort) > 65535) throw new Error("gatePort is invalid");
  const retention = Number.isSafeInteger(options.retention) ? options.retention : 3;
  if (retention < 2) throw new Error("retention must be at least 2 (current plus previous)");
  const llm = options.llm === false ? null : deployerModelRoute();
  const vpnAddress = isIP3(String(options.host ?? "").trim()) === 0 ? "0.0.0.0" : String(options.host).trim();
  const interop = {
    port: Number.isSafeInteger(options.interopPort) ? options.interopPort : 8765,
    // Only the VPN address: the token is the gateway password, so the service
    // must not be reachable from the member's public interface.
    bind: vpnAddress,
    provider: llm?.provider ?? "deepseek-account",
    model: llm?.model ?? "deepseek-flash"
  };
  const serviceUser = typeof options.serviceUser === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/u.test(options.serviceUser.trim()) ? options.serviceUser.trim() : void 0;
  return {
    host: options.host.trim(),
    // The local host runs the same phases without SSH: the gateway upgrading
    // itself must not depend on its own sshd being reachable.
    local: options.local === true,
    // Copied from the deployer so every member shares one gateway password;
    // empty means "generate on the target".
    gatePassword: typeof options.gatePassword === "string" ? options.gatePassword : "",
    user: typeof options.user === "string" && options.user.trim() !== "" ? options.user.trim() : void 0,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === "string" && options.identityFile.trim() !== "" ? path14.resolve(options.identityFile) : void 0,
    os: os9,
    package: { path: packagePath, bytes: packageInfo2?.size ?? 0, sha256 },
    release,
    appRoot,
    serviceUser,
    shared: `${appRoot}${os9 === "linux" ? "/shared" : "\\shared"}`,
    current: `${appRoot}${os9 === "linux" ? "/current" : "\\current"}`,
    previous: `${appRoot}${os9 === "linux" ? "/previous" : "\\previous"}`,
    releases: `${appRoot}${os9 === "linux" ? "/releases" : "\\releases"}`,
    services,
    scope,
    gatePort,
    retention,
    sudo: options.sudo !== false,
    // BBR + fq on the member: the one step that makes a high-latency, lossy
    // mesh link usable. Set DSH_DEPLOY_NET_TUNE=0 to leave the host alone.
    tuneNetwork: options.tuneNetwork !== false && process.env.DSH_DEPLOY_NET_TUNE !== "0",
    // The provider route the member's agent should use. Without it a fresh
    // profile falls back to the API-key route and cannot spend the deployer's
    // shared login. Set DSH_DEPLOY_SYNC_MODEL=0 to leave the member's own.
    llm,
    // The interop service is what lets other members drive a conversation here
    // (call_member, the panel's conversation list), so the deploy installs and
    // starts it instead of leaving it to a manual script.
    interop: options.interop === false || process.env.DSH_DEPLOY_INTEROP === "0" ? null : interop,
    // Named by content, not by release, so a retried deploy of the same package
    // reuses the upload instead of pushing hundreds of megabytes again.
    remotePackage: os9 === "linux" ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}${path14.extname(packagePath)}` : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}${path14.extname(packagePath)}`,
    // A test upgrade rehearses the *flat* upgrade (the path the gateway uses
    // on itself) in a sandbox on the member before touching it, then runs the
    // normal blue-green upgrade. Without this a member test proves nothing
    // about the local path.
    test: options.test === true,
    // The deployer's account grants travel with the deploy so a fresh member
    // needs no QR scan of its own.
    remoteCredentials: os9 === "linux" ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}.account` : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}.account`,
    // When the gateway has a release configured, an upgrade may fetch the
    // archive on the member instead of receiving it through the gateway. The
    // plan carries only URLs and the proxy's SSH coordinates; tokens never
    // leave the gateway.
    download: options.download === null || options.download === void 0 ? null : options.download
  };
}
async function probeTarget(options) {
  if (typeof options.host !== "string" || options.host.trim() === "") throw new Error("host is required");
  const os9 = normalizeOs(options.os ?? "linux");
  const user = typeof options.user === "string" && options.user.trim() !== "" ? options.user.trim() : void 0;
  const plan = {
    host: options.host.trim(),
    user,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === "string" && options.identityFile.trim() !== "" ? path14.resolve(options.identityFile) : void 0,
    os: os9
  };
  const runner = new SshRunner(plan);
  if (os9 === "windows") {
    const script2 = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$svc = Get-CimInstance Win32_Service -Filter "Name='DSH-Mesh'"`,
      "$root = ''",
      "if ($svc -and $svc.PathName) {",
      `  if ($svc.PathName -match '^"([^"]+)"') { $exe = $matches[1] } else { $exe = ($svc.PathName -split ' ')[0] }`,
      "  $root = Split-Path -Parent $exe",
      "}",
      "if (-not $root) { $root = Join-Path $env:USERPROFILE '.dsh\\dsh-mesh' }",
      "$root = $root -replace '(?i)\\\\current$', ''",
      "Write-Output $root",
      "Write-Output $env:USERNAME"
    ].join("\n");
    const encoded = Buffer.from(script2, "utf16le").toString("base64");
    const { stdout: stdout2 } = await runner.runProcess("ssh", [
      ...runner.sshOptions(),
      runner.target(),
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
    ]);
    const [root2 = ""] = stdout2.split(/\r?\n/u);
    const appRoot = normalizeInstallRoot(root2) !== "" ? normalizeInstallRoot(root2) : `C:\\Users\\${user ?? "Public"}\\.dsh\\dsh-mesh`;
    return { appRoot, serviceUser: void 0 };
  }
  const script = `#!/usr/bin/env bash
set -u
root=''
runuser=''
for unit in dsh-web-gate.service dsh-web.service dsh-mesh.service; do
  if command -v systemctl >/dev/null 2>&1; then
    root=$(systemctl show "$unit" -p WorkingDirectory --value 2>/dev/null || true)
  fi
  if [ -n "$root" ]; then
    runuser=$(systemctl show "$unit" -p User --value 2>/dev/null || true)
    break
  fi
done
if [ -z "$root" ]; then
  root="\${HOME:-/root}/.dsh/dsh-mesh"
fi
case "$root" in
  */current) root=$(dirname "$root") ;;
esac
printf '%s\\n%s\\n' "$root" "$runuser"
`;
  const { stdout } = await runner.runProcess("ssh", [
    ...runner.sshOptions(),
    runner.target(),
    "bash -s"
  ], script);
  const [root = "", serviceUser = ""] = stdout.split(/\r?\n/u);
  const fallback = user !== void 0 && user !== "root" ? `/home/${user}/.dsh/dsh-mesh` : "/root/.dsh/dsh-mesh";
  return {
    appRoot: root.trim() !== "" ? root.trim() : fallback,
    serviceUser: serviceUser.trim() !== "" ? serviceUser.trim() : void 0
  };
}
function buildLinuxPrepareScript(plan) {
  const serviceBlocks = plan.services.map((service) => {
    const unit = sh(service.name);
    const command = service.command.startsWith("/") ? service.command : `${plan.appRoot}/current/${service.command}`;
    return `write_unit ${unit} ${sh(command)}`;
  }).join("\n");
  const chown = plan.serviceUser === void 0 || plan.serviceUser === "root" ? "" : `chown -R ${sh(`${plan.serviceUser}:`)} "$APP_ROOT" 2>/dev/null || true
`;
  const llmArgs = plan.llm === null || plan.llm === void 0 ? "" : `${[plan.llm.provider, plan.llm.model ?? "", plan.llm.reasoningEffort ?? ""].map((value) => sh(value)).join(" ")} `;
  const netTune = plan.tuneNetwork === false ? "" : `if command -v sysctl >/dev/null 2>&1; then
  mkdir -p /etc/sysctl.d
  modprobe tcp_bbr 2>/dev/null || true
  modprobe sch_fq 2>/dev/null || true
  if grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null; then
    printf '%s\\n' 'net.core.default_qdisc=fq' 'net.ipv4.tcp_congestion_control=bbr' > /etc/sysctl.d/99-dsh-mesh-net.conf
    sysctl --system >/dev/null 2>&1 || true
    echo 'network tuning: bbr + fq enabled'
  else
    echo 'network tuning: bbr unavailable on this kernel, skipped'
  fi
fi
`;
  const wgPersist = plan.os === "linux" ? `for conf in /etc/wireguard/*.conf; do
  [ -f "$conf" ] || continue
  grep -q '^# Managed by the dsh-wireguard client bootstrap' "$conf" || continue
  iface=$(basename "$conf" .conf)
  systemctl enable "wg-quick@$iface" >/dev/null 2>&1 || true
  echo "wg-quick@$iface enabled for boot"
done
` : "";
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
RELEASE=${sh(plan.release)}
PACKAGE=${sh(plan.remotePackage)}
NEW="$APP_ROOT/releases/$RELEASE"
SHARED="$APP_ROOT/shared"
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
mkdir -p "$APP_ROOT/releases" "$SHARED"
# A failed prepare or activate can leave a whole release tree behind (about
# 1.3 GB each). Keep only the running release and the rollback target; $NEW
# does not exist yet unless this is a retry, and that case is refused below.
CURRENT_REAL=$(readlink -f "$CURRENT" 2>/dev/null || true)
PREVIOUS_REAL=$(readlink -f "$PREVIOUS" 2>/dev/null || true)
for old in "$APP_ROOT"/releases/*; do
  [ -d "$old" ] || continue
  if [ "$old" = "$CURRENT_REAL" ] || [ "$old" = "$PREVIOUS_REAL" ] || [ "$old" = "$NEW" ]; then
    continue
  fi
  rm -rf "$old" 2>/dev/null || true
done
if [ -e "$NEW" ]; then
  echo "release already exists: $NEW" >&2
  exit 1
fi
mkdir -p "$NEW"
# One marker per ${String(EXTRACT_CHECKPOINT)} extracted entries: the deploy engine turns
# these into the panel's extraction progress. Counting first costs a gzip pass
# but gives an honest denominator; printing every path would flood the job log
# with 78k lines.
#
# Do not use tar's --checkpoint-action here: %u is the number of 10 KiB records
# read, not entries, so multiplying it by the checkpoint interval produced
# numbers far larger than the archive's entry count (and a bar stuck at 99%).
printf 'DSH-MESH-EXTRACT-TOTAL %s
' "$(tar -tzf "$PACKAGE" | wc -l | tr -d ' ')"
tar -xzf "$PACKAGE" -C "$NEW" --strip-components=1 -v | {
  extracted=0
  while IFS= read -r _entry; do
    extracted=$((extracted + 1))
    if [ $((extracted % ${String(EXTRACT_CHECKPOINT)})) -eq 0 ]; then printf 'DSH-MESH-EXTRACT %s
' "$extracted"; fi
  done
}

# Drop the archive as soon as it is expanded: it is 300+ MiB, /tmp on a member
# is often a small tmpfs, and one copy left behind per job eventually fills it
# so the next upload dies halfway with a bare scp "Failure".
rm -f "$PACKAGE"

# Shared mutable state stays outside every release. The first deploy copies it
# from the currently running tree; later deploys inherit it untouched.
for dir in config data home workspace; do
  if [ ! -e "$SHARED/$dir" ]; then
    if [ -e "$CURRENT/$dir" ]; then
      cp -a "$CURRENT/$dir" "$SHARED/$dir"
    else
      mkdir -p "$SHARED/$dir"
    fi
  fi
  rm -rf "$NEW/$dir"
  ln -s "$SHARED/$dir" "$NEW/$dir"
done
${chown}
ENV_FILE="$SHARED/config/gate.env"
if [ ! -f "$ENV_FILE" ]; then
  # A member that was never installed has no shared config yet. The deploy
  # already carries the package, the units and the password, so seed the same
  # fields install.sh writes instead of refusing the first deploy.
  mkdir -p "$SHARED/config" "$SHARED/home" "$SHARED/workspace"
  cat > "$ENV_FILE" <<'DSH_MESH_ENV'
# dsh-mesh\uFF1A\u7531\u9996\u6B21 SSH \u90E8\u7F72\u751F\u6210\u7684\u7F51\u5173\u914D\u7F6E\uFF08\u4E0E install.sh \u7684\u6A21\u677F\u7B49\u4EF7\uFF09
DSH_GATE_BIND=::
DSH_GATE_COOKIE_DAYS=30
DSH_WEB_PORT=31280
DSH_MESH_ENV
  printf 'DSH_GATE_PORT=%s\\n' ${sh(plan.gatePort)} >> "$ENV_FILE"
  printf 'DSH_GATE_PASSWORD=%s\\n' ${sh(plan.gatePassword || "ChangeMe-Please-2026")} >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "seeded $ENV_FILE for a first deploy"
fi
${plan.serviceUser === void 0 || plan.serviceUser === "root" ? "" : `chown ${sh(`${plan.serviceUser}:`)} "$ENV_FILE" 2>/dev/null || true`}
sed -i "s|^DSH_HOME=.*|DSH_HOME=$SHARED/home|" "$ENV_FILE"
sed -i "s|^DSH_WORKDIR=.*|DSH_WORKDIR=$SHARED/workspace|" "$ENV_FILE"
grep -q '^DSH_HOME=' "$ENV_FILE" || echo "DSH_HOME=$SHARED/home" >> "$ENV_FILE"
grep -q '^DSH_WORKDIR=' "$ENV_FILE" || echo "DSH_WORKDIR=$SHARED/workspace" >> "$ENV_FILE"
# The gateway password belongs to the deployer: peer requests are signed with a
# secret derived from it, so members only need to share this password.
${plan.gatePassword ? `sed -i ${sh(`s|^DSH_GATE_PASSWORD=.*|DSH_GATE_PASSWORD=${sedReplacement(plan.gatePassword)}|`)} "$ENV_FILE"
grep -q '^DSH_GATE_PASSWORD=' "$ENV_FILE" || echo ${sh(`DSH_GATE_PASSWORD=${plan.gatePassword}`)} >> "$ENV_FILE"
echo 'gateway password synced from the deployer'
` : ""}sed -i '/^DSH_GATE_CLUSTER_KEY=/d' "$ENV_FILE"
# An archive written on a filesystem without modes (or an old package) can lose
# the executable bit on the launch scripts.
chmod +x "$NEW"/*.sh 2>/dev/null || true
# The runtime ships as runtime/node/bin/node; older packages used runtime/node/node.
NODE_BIN="$NEW/runtime/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then NODE_BIN="$NEW/runtime/node/node"; fi
if [ ! -x "$NODE_BIN" ]; then echo "missing the node binary under $NEW/runtime/node" >&2; exit 1; fi
chmod +x "$NODE_BIN" 2>/dev/null || true
"$NODE_BIN" --check "$NEW/gate/server.mjs"
${netTune}${wgPersist}"$NODE_BIN" - "$SHARED/home/profiles/web" "$NEW/plugins/dsh-mesh" ${llmArgs}<<'DSH_MESH_PROFILE_WIRE'
${PROFILE_WIRE_SCRIPT}
DSH_MESH_PROFILE_WIRE
# The deployer's account grants make this member signed in without a QR scan.
CREDENTIALS_FILE=${sh(plan.remoteCredentials)}
if [ -f "$CREDENTIALS_FILE" ]; then
  MERGE_HELPER="$NEW/shared/credentials-merge.mjs"
  if [ -f "$CREDENTIALS_FILE.mjs" ]; then MERGE_HELPER="$CREDENTIALS_FILE.mjs"; fi
  if "$NODE_BIN" "$MERGE_HELPER" "$SHARED/home/.credentials.yaml" "$CREDENTIALS_FILE"; then
    rm -f "$CREDENTIALS_FILE" "$CREDENTIALS_FILE.mjs"
  else
    echo "could not copy the deployer account sign-in" >&2
  fi
fi
test -f "$NEW/manifest.json"

write_unit() {
  local unit="$1"
  local command="$2"
  local dropin="/etc/systemd/system/$unit.d"
  mkdir -p "$dropin"
  cat > "$dropin/dsh-release.conf" <<EOF
[Service]
WorkingDirectory=$APP_ROOT/current
ExecStart=
ExecStart=$command
EOF
  # A machine that never ran install.sh has no unit to extend; write a minimal
  # one so the drop-in above has something to override.
  if [ ! -f "/etc/systemd/system/$unit" ]; then
    cat > "/etc/systemd/system/$unit" <<EOF
[Unit]
Description=$unit (dsh-mesh)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_ROOT/current
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  fi
  systemctl enable "$unit" >/dev/null 2>&1 || true
}
${serviceBlocks}
${plan.interop === null || plan.interop === void 0 ? "" : `# The interop listener now runs inside DSH Web (the dsh-mesh plugin owns
# :8765 and drives sessions through the host's own agent registry). The
# configuration stays here: the plugin reads this file, and the gateway's
# control service / member task tool authenticate with the gateway password.
INTEROP_ENV="$SHARED/config/interop.env"
cat > "$INTEROP_ENV" <<EOF
# generated by the dsh-mesh deploy
DSH_HOME=$SHARED/home
DSH_WORKDIR=$SHARED/workspace
DSH_INTEROP_BIND=${plan.interop.bind}
DSH_INTEROP_PORT=${plan.interop.port}
DSH_INTEROP_PROVIDER=${plan.interop.provider}
DSH_INTEROP_MODEL=${plan.interop.model}
DSH_INTEROP_APPROVE=1
DSH_INTEROP_USE_GATE_PASSWORD=1
EOF
chmod 600 "$INTEROP_ENV"
# Keep the standalone unit on disk for a rollback to a release that predates
# the embedded listener, but never start it: DSH Web binds the same port.
write_unit dsh-interop.service "$APP_ROOT/current/start-interop.sh"
systemctl disable --now dsh-interop.service >/dev/null 2>&1 || true
echo "embedded interop in DSH Web on ${plan.interop.bind}:${plan.interop.port}; standalone unit disabled"
`}systemctl daemon-reload
echo "prepared $RELEASE at $NEW"
`;
}
function buildLinuxActivateScript(plan) {
  const restart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `systemctl restart ${sh(service.name)}`).join("\n");
  const rollbackRestart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `systemctl restart ${sh(service.name)}`).join("\n");
  const interopHost = plan.interop === null || plan.interop === void 0 ? null : plan.interop.bind === "0.0.0.0" ? "127.0.0.1" : plan.interop.bind;
  const interopHealth = interopHost === null ? "  return 0" : `  # The old stack may still own :8765 while its service stops; wait out the
  # handover before accepting the new process's marker.
  sleep 10
  for _ in $(seq 1 30); do
    if curl -fsS "http://${interopHost}:${plan.interop.port}/healthz" 2>/dev/null | grep -q "dsh-mesh-embedded-interop-v1"; then
      return 0
    fi
    sleep 2
  done
  return 1`;
  const interopHealthLoose = interopHost === null ? "  return 0" : `  sleep 10
  for _ in $(seq 1 30); do
    if curl -fsS "http://${interopHost}:${plan.interop.port}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1`;
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
RELEASE=${sh(plan.release)}
NEW="$APP_ROOT/releases/$RELEASE"
SHARED="$APP_ROOT/shared"
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
PORT=$(sed -n 's/^DSH_GATE_PORT=//p' "$SHARED/config/gate.env" | tail -n1)
PORT=\${PORT:-${plan.gatePort}}
OLD=$(readlink -f "$CURRENT" 2>/dev/null || true)
if [ -n "$OLD" ]; then
  ln -sfn "$OLD" "$PREVIOUS"
fi
ln -sfn "$NEW" "$CURRENT"

# After an upgrade the member's gate shows the acceptance page first. A first
# install has no previous release and nothing to accept, so it writes nothing.
PENDING="$SHARED/data/upgrade-pending.json"
rm -f "$PENDING" 2>/dev/null || true
if [ -n "$OLD" ] && grep -q '__gate/fallback' "$NEW/gate/server.mjs" 2>/dev/null; then
  MARKER_NODE="$NEW/runtime/node/bin/node"
  [ -x "$MARKER_NODE" ] || MARKER_NODE="$NEW/runtime/node/node"
  [ -x "$MARKER_NODE" ] || MARKER_NODE=$(command -v node || true)
  if [ -n "$MARKER_NODE" ]; then
    FROM_VERSION=$("$MARKER_NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$OLD/manifest.json" 2>/dev/null || true)
    TO_VERSION=$("$MARKER_NODE" -e 'try{process.stdout.write(String(require(process.argv[1]).version||""))}catch(e){}' "$NEW/manifest.json" 2>/dev/null || true)
    FROM_VERSION=\${FROM_VERSION:-unknown}
    TO_VERSION=\${TO_VERSION:-unknown}
    mkdir -p "$SHARED/data"
    "$MARKER_NODE" - "$PENDING" "$APP_ROOT" "$NEW" "$OLD" "$FROM_VERSION" "$TO_VERSION" "$PORT" "$SHARED/home" <<'DSH_MESH_PENDING'
const fs = require('fs')
const [file, root, release, previous, from, to, port, dshHome] = process.argv.slice(2)
const state = {
  format: 1,
  status: 'pending',
  layout: 'bluegreen',
  root,
  release,
  previous,
  from,
  to,
  port: Number(port) || 80,
  dshHome,
  upgradedAt: new Date().toISOString(),
}
fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\\n", { mode: 0o600 })
DSH_MESH_PENDING
  fi
fi

# A failing systemctl restart must not abort the script: with set -e that
# used to exit *after* current had already moved, leaving the member on a
# release whose services never came up \u2014 and no rollback. Collect the failures
# and let the single rollback path below decide.
restart_services() {
  local failed=0
${restart.split("\n").map((line) => `  ${line} || failed=1`).join("\n")}
  return "$failed"
}
health() {
  local gate_ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then
      gate_ok=1
      break
    fi
    sleep 2
  done
  if [ "$gate_ok" != "1" ]; then return 1; fi
${interopHealth}
}
health_loose() {
  local gate_ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then
      gate_ok=1
      break
    fi
    sleep 2
  done
  if [ "$gate_ok" != "1" ]; then return 1; fi
${interopHealthLoose}
}
ROLLED_BACK=0
rollback() {
  if [ "$ROLLED_BACK" = "1" ]; then return 0; fi
  ROLLED_BACK=1
  rm -f "$SHARED/data/upgrade-pending.json" 2>/dev/null || true
  if [ -z "$OLD" ]; then
    echo "no previous release to roll back to; $CURRENT stays on $RELEASE" >&2
    return 1
  fi
  echo "rolling back to $OLD" >&2
  ln -sfn "$OLD" "$CURRENT"
${rollbackRestart.split("\n").map((line) => `  ${line} || true`).join("\n")}
  # A release that shipped before the embedded listener still needs the
  # standalone unit; an embedded release must keep it stopped or the plugin
  # cannot bind :8765.
  if { [ -f "$OLD/manifest.json" ] && grep -q "embedded-interop" "$OLD/manifest.json"; } || grep -q "dsh-mesh-embedded-interop-v1" "$OLD/plugins/dsh-mesh/index.js" 2>/dev/null; then
    systemctl stop dsh-interop.service 2>/dev/null || true
    systemctl disable dsh-interop.service 2>/dev/null || true
  else
    systemctl enable --now dsh-interop.service 2>/dev/null || true
  fi
  if health_loose; then
    echo "rollback finished: $OLD answers the health check" >&2
  else
    echo "rollback finished but $OLD did not answer the health check; it needs a manual look" >&2
  fi
  # A failed release is no longer referenced, but it is a full package tree
  # (about 1.3 GB); leaving one behind per failed attempt fills the disk. Keep
  # it when the rollback did not actually move current away from it.
  if [ -n "$NEW" ] && [ "$(readlink -f "$CURRENT" 2>/dev/null || true)" != "$(readlink -f "$NEW" 2>/dev/null || true)" ]; then
    rm -rf "$NEW" 2>/dev/null || true
    echo "removed the failed release $NEW" >&2
  fi
  return 0
}
# Any unexpected failure after the switch (a missing binary, a full disk) takes
# the same rollback path instead of leaving the release half-applied.
set -E
trap 'rollback || true' ERR
if ! restart_services; then
  echo "a service failed to restart on $RELEASE; rolling back" >&2
  rollback || true
  exit 1
fi
# DSH Web hosts the interop listener; never let the standalone unit race it.
systemctl stop dsh-interop.service >/dev/null 2>&1 || true
systemctl disable dsh-interop.service >/dev/null 2>&1 || true
if ! health; then
  echo "health check failed on $RELEASE; rolling back" >&2
  rollback || true
  exit 1
fi
trap - ERR
# Retention: keep the newest N releases and never the current/previous target.
mapfile -t RELEASES < <(ls -1dt "$APP_ROOT/releases"/* 2>/dev/null || true)
for ((i=${plan.retention}; i<\${#RELEASES[@]}; i++)); do
  old="\${RELEASES[$i]}"
  [ "$(readlink -f "$CURRENT")" = "$old" ] && continue
  [ "$(readlink -f "$PREVIOUS")" = "$old" ] && continue
  rm -rf "$old" || true
done
echo "activated $RELEASE"
`;
}
function buildLinuxRehearseScript(plan) {
  return `set -Eeuo pipefail
APP_ROOT=${sh(plan.appRoot)}
CURRENT="$APP_ROOT/current"
SHARED=${sh(plan.shared)}
PKG=${sh(plan.remotePackage)}
RELEASE=${sh(plan.release)}
TEST_PARENT="$APP_ROOT/../.dsh-mesh-test"
TEST_ROOT="$TEST_PARENT/$RELEASE"
APP="$TEST_ROOT/app"
TEST_HOME="$TEST_ROOT/home"
STAGE="$TEST_ROOT/stage"
say() { printf '==> %s\\n' "$*"; }
fail() { printf '[\u6F14\u7EC3\u5931\u8D25] %s\\n' "$*" >&2; exit 1; }
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '[\u6F14\u7EC3\u5931\u8D25] \u6C99\u7BB1\u4FDD\u7559\u5728 %s \u4F9B\u6392\u67E5\uFF08\u4E0B\u6B21\u6F14\u7EC3\u4F1A\u5148\u6E05\u6389\uFF09\\n' "$TEST_ROOT" >&2
    return 0
  fi
  rm -rf "$TEST_ROOT"
  rmdir "$TEST_PARENT" 2>/dev/null || true
}
trap cleanup EXIT
[ -f "$PKG" ] || fail "\u5305\u4E0D\u5728\u76EE\u6807\u673A\u4E0A\uFF1A$PKG"
[ -d "$CURRENT/plugins/dsh-mesh" ] || fail "\u76EE\u6807\u6210\u5458\u5F53\u524D\u7248\u672C\u91CC\u6CA1\u6709 plugins/dsh-mesh\uFF0C\u65E0\u6CD5\u6784\u9020\u5347\u7EA7\u524D\u72B6\u6001"
[ -f "$SHARED/config/gate.env" ] || fail "\u76EE\u6807\u6210\u5458\u6CA1\u6709 $SHARED/config/gate.env\uFF0C\u4E0D\u662F dsh-mesh \u5B89\u88C5"
# \u4E0A\u4E00\u6B21\u5931\u8D25\u7559\u4E0B\u7684\u6C99\u7BB1\u5148\u6E05\u6389\uFF0C\u907F\u514D\u6C38\u4E45\u5806\u79EF\u3002
rm -rf "$TEST_PARENT"
mkdir -p "$APP/config" "$APP/plugins" "$TEST_HOME/profiles/web" "$TEST_ROOT/tools" "$STAGE"
# \u89E3\u6790\u6210\u7EDD\u5BF9\u8DEF\u5F84\uFF1Awire-profile \u5199\u7684\u662F\u7EDD\u5BF9 link: \u76EE\u6807\uFF0C\u5E26 .. \u7684\u8DEF\u5F84\u6C38\u8FDC\u6BD4\u4E0D\u76F8\u7B49\u3002
TEST_ROOT=$(CDPATH= cd -- "$TEST_ROOT" && pwd)
APP="$TEST_ROOT/app"
TEST_HOME="$TEST_ROOT/home"
STAGE="$TEST_ROOT/stage"
say "\u5E73\u94FA\u5347\u7EA7\u6F14\u7EC3\uFF1A\u89E3\u538B\u65B0\u5305\u5E76\u590D\u523B\u76EE\u6807\u6210\u5458\u5F53\u524D\u7248\u672C\uFF08\u6C99\u7BB1 $TEST_ROOT\uFF09"
tar -xzf "$PKG" -C "$STAGE" --strip-components=1
NODE="$STAGE/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] || fail '\u6F14\u7EC3\u9700\u8981 node\uFF08\u5305\u5185 runtime \u6216\u7CFB\u7EDF node\uFF09'
# \u5347\u7EA7\u524D\u7684\u72B6\u6001\u5C3D\u91CF\u7528\u76EE\u6807\u6210\u5458\u7684\u771F\u5B9E\u6587\u4EF6\uFF0C\u800C\u4E0D\u662F\u53EA\u9020\u4E00\u4E2A plugins \u76EE\u5F55\uFF1A
# \u5907\u4EFD\u8303\u56F4\uFF08code/gate/manifest/start.sh\uFF09\u3001\u771F\u5B9E gate.env\u3001\u771F\u5B9E profile \u6E05\u5355\u90FD\u8981\u80FD\u6D4B\u5230\u3002
cp -a "$CURRENT/plugins/." "$APP/plugins/"
for item in code gate locale manifest.json start.sh start-dsh.sh start-interop.sh; do
  if [ -e "$CURRENT/$item" ]; then cp -a "$CURRENT/$item" "$APP/"; fi
done
if [ -d "$CURRENT/config" ]; then cp -a "$CURRENT/config/." "$APP/config/"; fi
cp -a "$SHARED/config/gate.env" "$APP/config/gate.env"
PROFILE_SRC="$SHARED/home/profiles/web"
for file in package.json cordis.patch.yml; do
  if [ -f "$PROFILE_SRC/$file" ]; then cp -a "$PROFILE_SRC/$file" "$TEST_HOME/profiles/web/"; fi
done
# \u6C99\u7BB1\u7528\u81EA\u5DF1\u7684 DSH_HOME \u548C\u7A7A\u95F2\u7AEF\u53E3\uFF0C\u522B\u78B0\u6210\u5458\u771F\u5B9E\u7684 80/8765\u3002
sed -i -e "s|^DSH_HOME=.*|DSH_HOME=$TEST_HOME|" -e "s|^DSH_GATE_PORT=.*|DSH_GATE_PORT=18080|" "$APP/config/gate.env"
grep -q '^DSH_GATE_PORT=' "$APP/config/gate.env" || printf 'DSH_GATE_PORT=18080\\n' >> "$APP/config/gate.env"
grep -q '^DSH_HOME=' "$APP/config/gate.env" || printf 'DSH_HOME=%s\\n' "$TEST_HOME" >> "$APP/config/gate.env"
BEFORE=$("$NODE" -p "require('$APP/plugins/dsh-mesh/package.json').version" 2>/dev/null || echo unknown)
say "\u5347\u7EA7\u524D\u7684\u6C99\u7BB1\u7248\u672C\uFF1A$BEFORE\uFF08\u4EE5\u6587\u4EF6\u5185\u5BB9\u5224\u65AD\u662F\u5426\u771F\u7684\u8986\u76D6\uFF09"
# \u811A\u672C\u6765\u6E90\u4E0E\u751F\u4EA7\u4E00\u81F4\uFF1A\u4F18\u5148\u7528\u65B0\u5305\u91CC\u7684\u90A3\u4EFD\uFF08runner.mjs \u4E5F\u662F\u8FD9\u4E48\u505A\u7684\uFF09\uFF0C
# \u8FD9\u6837\u65B0\u5305\u7684\u5907\u4EFD\u8303\u56F4/\u56DE\u9000\u903B\u8F91\u5728\u5B83\u81EA\u5DF1\u7684\u5347\u7EA7\u91CC\u5C31\u751F\u6548\uFF1B\u53EA\u6709\u8001\u5305\u4E0D\u5E26
# code/deploy \u65F6\u624D\u9000\u56DE\u5DF2\u5B89\u88C5\u63D2\u4EF6\u91CC\u7684\u90A3\u4EFD\u3002
PLUGIN_DEPLOY="$CURRENT/plugins/dsh-mesh/code/deploy"
if [ -f "$STAGE/code/deploy/upgrade-local.sh" ]; then
  SCRIPT_SRC="$STAGE/code/deploy/upgrade-local.sh"
  say '\u811A\u672C\u6765\u6E90\uFF1A\u65B0\u5305\uFF08\u4E0E\u300C\u5347\u7EA7\u300D\u540C\u6E90\uFF09'
  if [ -f "$PLUGIN_DEPLOY/upgrade-local.sh" ]; then
    A=$(sha256sum "$SCRIPT_SRC" | cut -d' ' -f1)
    B=$(sha256sum "$PLUGIN_DEPLOY/upgrade-local.sh" | cut -d' ' -f1)
    if [ "$A" != "$B" ]; then say '\u6CE8\u610F\uFF1A\u65B0\u5305\u91CC\u7684\u811A\u672C\u4E0E\u5DF2\u5B89\u88C5\u63D2\u4EF6\u7684\u4E0D\u4E00\u81F4\uFF0C\u6309\u751F\u4EA7\u884C\u4E3A\u4EE5\u65B0\u5305\u4E3A\u51C6'; fi
  fi
else
  SCRIPT_SRC="$PLUGIN_DEPLOY/upgrade-local.sh"
  say '\u811A\u672C\u6765\u6E90\uFF1A\u5DF2\u5B89\u88C5\u63D2\u4EF6\uFF08\u65B0\u5305\u662F\u65E9\u4E8E\u4FEE\u590D\u7684\u7248\u672C\uFF0C\u6CA1\u6709 code/deploy\uFF09'
fi
[ -f "$SCRIPT_SRC" ] || fail '\u5DF2\u5B89\u88C5\u63D2\u4EF6\u548C\u65B0\u5305\u91CC\u90FD\u6CA1\u6709 code/deploy/upgrade-local.sh\uFF0C\u8FD9\u4E2A\u5305\u505A\u4E0D\u4E86\u5E73\u94FA\u5347\u7EA7'
cp "$SCRIPT_SRC" "$TEST_ROOT/tools/upgrade-local.sh"
if [ -f "$(dirname "$SCRIPT_SRC")/wire-profile.mjs" ]; then
  cp "$(dirname "$SCRIPT_SRC")/wire-profile.mjs" "$TEST_ROOT/tools/wire-profile.mjs"
elif [ -f "$STAGE/code/deploy/wire-profile.mjs" ]; then
  cp "$STAGE/code/deploy/wire-profile.mjs" "$TEST_ROOT/tools/wire-profile.mjs"
else
  fail '\u627E\u4E0D\u5230 wire-profile.mjs\uFF08\u811A\u672C\u76EE\u5F55\u548C\u65B0\u5305\u91CC\u90FD\u6CA1\u6709\uFF09'
fi
chmod +x "$TEST_ROOT/tools/upgrade-local.sh"
say '\u7B2C\u4E00\u6B65\uFF1A\u6B63\u5E38\u5347\u7EA7\u6C99\u7BB1\uFF08--no-restart\uFF1A\u5907\u4EFD\u3001\u8986\u76D6\u3001\u63A5\u7EBF\uFF1B\u4E0D\u78B0\u4EFB\u4F55\u670D\u52A1\uFF09'
bash "$TEST_ROOT/tools/upgrade-local.sh" --app-root "$APP" --stage "$STAGE" --dsh-home "$TEST_HOME" --port 18080 --no-restart
say '\u6838\u5BF9\u5347\u7EA7\u7ED3\u679C'
BACKUP_DIR=$(ls -1d "$APP/.upgrade-backup"/* 2>/dev/null | head -n1 || true)
[ -n "$BACKUP_DIR" ] || fail '\u5347\u7EA7\u6CA1\u6709\u7559\u4E0B .upgrade-backup \u5907\u4EFD'
for item in plugins code gate manifest.json; do
  if [ -e "$CURRENT/$item" ]; then
    [ -e "$BACKUP_DIR/$item" ] || fail "\u5907\u4EFD\u7F3A $item\uFF1A\u5E73\u94FA\u5347\u7EA7\u7684\u5907\u4EFD\u8303\u56F4\u4E0D\u5BF9"
  fi
done
cmp -s "$BACKUP_DIR/plugins/dsh-mesh/index.js" "$CURRENT/plugins/dsh-mesh/index.js" || fail '\u5907\u4EFD\u91CC\u7684\u63D2\u4EF6\u4E0D\u662F\u5347\u7EA7\u524D\u90A3\u4E00\u4EFD'
cmp -s "$APP/plugins/dsh-mesh/index.js" "$STAGE/plugins/dsh-mesh/index.js" || fail '\u8986\u76D6\u540E\u7684\u63D2\u4EF6\u4E0D\u662F\u65B0\u5305\u90A3\u4E00\u4EFD'
AFTER=$("$NODE" -p "require('$APP/plugins/dsh-mesh/package.json').version")
say "\u5347\u7EA7\u540E\u7684\u6C99\u7BB1\u7248\u672C\uFF1A$AFTER\uFF1B\u5907\u4EFD\u4E0E\u8986\u76D6\u9010\u5B57\u8282\u6838\u5BF9\u8FC7"
LINK=$("$NODE" -e "const p=require('$TEST_HOME/profiles/web/package.json');process.stdout.write(String((p.dependencies||{})['@local/dsh-mesh']||''))")
[ "$LINK" = "link:$APP/plugins/dsh-mesh" ] || fail "profile \u7684 @local/dsh-mesh \u63A5\u7EBF\u4E0D\u5BF9\uFF1A$LINK"
say "profile \u63A5\u7EBF\uFF1A$LINK"
if [ -d "$STAGE/plugins/xl" ]; then
  [ -e "$TEST_HOME/profiles/web/node_modules/xl" ] || fail '\u65B0\u5305\u5E26\u4E86 xl\uFF0C\u4F46 profile \u6CA1\u6709\u63A5\u4E0A xl'
  say '\u968F\u5305\u63D2\u4EF6 xl \u5DF2\u63A5\u5165 profile'
fi
say '\u7B2C\u4E8C\u6B65\uFF1AChrome headless \u6293\u5C4F\u786E\u8BA4\u5347\u7EA7\u540E\u7684 DSH \u80FD\u542F\u52A8\u3001Mesh \u9762\u677F\u80FD\u51FA\u73B0'
SMOKE_SCRIPT="$APP/plugins/dsh-mesh/code/build/smoke-cli.mjs"
[ -f "$SMOKE_SCRIPT" ] || SMOKE_SCRIPT="$STAGE/plugins/dsh-mesh/code/build/smoke-cli.mjs"
[ -f "$SMOKE_SCRIPT" ] || fail '\u65B0\u5305\u91CC\u6CA1\u6709 code/build/smoke-cli.mjs\uFF0C\u65E0\u6CD5\u9A8C\u8BC1 DSH \u542F\u52A8\u4E0E Mesh \u9762\u677F'
# \u622A\u56FE\u7559\u5728\u6C99\u7BB1\u5916\u9762\uFF1A\u6210\u529F\u4F1A\u5220 TEST_ROOT\uFF0C\u5931\u8D25\u8981\u7559\u8BC1\u636E\u3002
SMOKE_SHOT="$APP_ROOT/.dsh-mesh-test-$RELEASE"
rm -rf "$SMOKE_SHOT"
mkdir -p "$SMOKE_SHOT"
# \u6210\u5458\u6CA1\u6709 Chrome/Chromium/Edge \u65F6\uFF0Csmoke-cli \u4F1A\u4E0B\u8F7D Chrome for Testing \u7684
# chrome-headless-shell\uFF08\u7F13\u5B58\u5230\u8FD0\u884C\u7528\u6237\u7684 ~/.cache/dsh-mesh/chrome\uFF09\u3002\u4E0B\u8F7D\u6216
# \u542F\u52A8\u5931\u8D25\u4E0D\u5E94\u8BA9\u5347\u7EA7\u6F14\u7EC3\u5931\u8D25\uFF1A\u90A3\u53EA\u662F\u8FD9\u53F0\u6210\u5458\u6682\u65F6\u6CA1\u6709\u53EF\u7528\u7684\u6D4F\u89C8\u5668\u3002
if "$NODE" "$SMOKE_SCRIPT" --install --root "$APP" --port 18081 --home "$TEST_HOME"     --workdir "$TEST_ROOT/workspace" --screenshot-dir "$SMOKE_SHOT" --download-chrome; then
  say "\u6293\u5C4F\u901A\u8FC7\uFF1ADSH \u5DF2\u542F\u52A8\uFF0CMesh \u9762\u677F\u5DF2\u51FA\u73B0\uFF08\u622A\u56FE $SMOKE_SHOT\uFF09"
else
  smoke_rc=$?
  if [ "$smoke_rc" = "3" ]; then
    say '\u6293\u5C4F\u8DF3\u8FC7\uFF1A\u6CA1\u6709\u53EF\u7528\u7684 Chrome/Chromium/Edge\uFF0C\u81EA\u52A8\u4E0B\u8F7D\u6216\u542F\u52A8\u4E5F\u5931\u8D25\uFF08\u8BE6\u89C1\u4E0A\u9762\u7684 [smoke] \u65E5\u5FD7\uFF1B\u6784\u5EFA\u673A\u4E0A\u7684\u300C\u6784\u5EFA\u540E\u6293\u5C4F\u300D\u4ECD\u4F1A\u6267\u884C\uFF09'
  else
    fail "\u5347\u7EA7\u540E\u7684\u6C99\u7BB1\u6CA1\u6709\u901A\u8FC7 Chrome \u6293\u5C4F\u5192\u70DF\uFF08\u9000\u51FA\u7801 $smoke_rc\uFF09\uFF1B\u622A\u56FE\u4E0E\u65E5\u5FD7\u5728 $SMOKE_SHOT"
  fi
fi

# \u7B2C\u4E09\u6B65\uFF1A\u6CE8\u5165\u4E00\u6B21\u201C\u63A5\u7EBF\u201D\u5931\u8D25\uFF0C\u9A8C\u8BC1 upgrade-local.sh \u7684 restore() \u80FD\u628A
# \u5DF2\u7ECF\u8986\u76D6\u8FC7\u7684\u6587\u4EF6\u8FD8\u539F\u3002\u6CE8\u5165\u65B9\u5F0F\u662F\u628A wire-profile \u6362\u6210\u5FC5\u5B9A\u5931\u8D25\u7684\u5C0F\u811A\u672C\uFF0C
# \u5B83\u4F1A\u7559\u4E0B\u4E00\u4E2A\u6807\u8BB0\uFF0C\u8BC1\u660E\u8986\u76D6\u5DF2\u7ECF\u53D1\u751F\u3001\u5931\u8D25\u70B9\u5728\u63A5\u7EBF\u3002
say '\u7B2C\u4E09\u6B65\uFF1A\u6CE8\u5165\u63A5\u7EBF\u5931\u8D25\uFF0C\u9A8C\u8BC1 restore() \u80FD\u8FD8\u539F'
cp -a "$STAGE/." "$TEST_ROOT/bad/"
printf '// bad stage
' > "$TEST_ROOT/bad/plugins/dsh-mesh/index.js"
mv "$TEST_ROOT/tools/wire-profile.mjs" "$TEST_ROOT/tools/wire-profile.real"
cat > "$TEST_ROOT/tools/wire-profile.mjs" <<'DSH_MESH_REHEARSE_STUB'
import { writeFileSync } from 'node:fs'
writeFileSync(new URL('../wiring-ran', import.meta.url), 'ran')
process.exit(3)
DSH_MESH_REHEARSE_STUB
chmod +x "$TEST_ROOT/tools/wire-profile.mjs"
MARK_BEFORE=$(sha256sum "$APP/plugins/dsh-mesh/index.js" "$APP/manifest.json" "$APP/config/gate.env")
if bash "$TEST_ROOT/tools/upgrade-local.sh" --app-root "$APP" --stage "$TEST_ROOT/bad" --dsh-home "$TEST_HOME" --port 18080 --no-restart; then
  fail '\u6CE8\u5165\u5931\u8D25\u540E\u811A\u672C\u5C45\u7136\u6210\u529F\u4E86\uFF1Arestore() \u8DEF\u5F84\u6CA1\u6709\u88AB\u6267\u884C'
fi
mv "$TEST_ROOT/tools/wire-profile.real" "$TEST_ROOT/tools/wire-profile.mjs"
[ -f "$TEST_ROOT/wiring-ran" ] || fail '\u6CE8\u5165\u7684\u5931\u8D25\u6CA1\u6709\u8D70\u5230\u63A5\u7EBF\u6B65\u9AA4\uFF1A\u5907\u4EFD/\u8986\u76D6\u6CA1\u6709\u88AB\u9A8C\u8BC1'
MARK_AFTER=$(sha256sum "$APP/plugins/dsh-mesh/index.js" "$APP/manifest.json" "$APP/config/gate.env")
[ "$MARK_BEFORE" = "$MARK_AFTER" ] || fail 'restore() \u6CA1\u6709\u628A\u8986\u76D6\u8FC7\u7684\u6587\u4EF6\u8FD8\u539F'
[ -f "$APP/plugins/dsh-mesh/index.js" ] || fail 'restore() \u4E4B\u540E index.js \u6CA1\u6709\u88AB\u8FD8\u539F\u6210\u6587\u4EF6'
say 'restore() \u5DF2\u9A8C\u8BC1\uFF1A\u63A5\u7EBF\u5931\u8D25\u540E\u6587\u4EF6\u56DE\u5230\u5347\u7EA7\u524D'
say '\u6F14\u7EC3\u901A\u8FC7\uFF1A\u5907\u4EFD\u3001\u8986\u76D6\u3001\u63A5\u7EBF\u3001\u5931\u8D25\u8FD8\u539F\u90FD\u6309\u672C\u673A\u300C\u5347\u7EA7\u300D\u7684\u811A\u672C\u8D70\u4E86\u4E00\u904D\uFF1B\u6C99\u7BB1\u5DF2\u6E05\u7406'
`;
}
function buildLinuxRollbackScript(plan) {
  const restart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `systemctl restart ${sh(service.name)}`).join("\n");
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
CURRENT="$APP_ROOT/current"
PREVIOUS="$APP_ROOT/previous"
OLD=$(readlink -f "$PREVIOUS" 2>/dev/null || true)
if [ -z "$OLD" ]; then
  echo "no previous release to roll back to" >&2
  exit 1
fi
ln -sfn "$OLD" "$CURRENT"
${restart}
if { [ -f "$OLD/manifest.json" ] && grep -q "embedded-interop" "$OLD/manifest.json"; } || grep -q "dsh-mesh-embedded-interop-v1" "$OLD/plugins/dsh-mesh/index.js" 2>/dev/null; then
  systemctl stop dsh-interop.service 2>/dev/null || true
  systemctl disable dsh-interop.service 2>/dev/null || true
else
  systemctl enable --now dsh-interop.service 2>/dev/null || true
fi
echo "rolled back to $OLD"
`;
}
function buildWindowsPrepareScript(plan) {
  const serviceLines = `# The gate spawns DSH itself, so a leftover split service would run a second
# copy on another port. Retire it once.
$legacy = Get-Service -Name 'DSH-Web-App' -ErrorAction SilentlyContinue
if ($null -ne $legacy) {
  Stop-Service -Name 'DSH-Web-App' -Force -ErrorAction SilentlyContinue
  & sc.exe delete 'DSH-Web-App' | Out-Null
  Write-Output 'removed the legacy DSH-Web-App service'
}
# A split install may have the standalone interop registered as its own
# service. DSH Web now binds :8765 in-process, so that service must not race it.
$legacyInterop = Get-Service -Name 'DSH-Interop' -ErrorAction SilentlyContinue
if ($null -ne $legacyInterop) {
  Stop-Service -Name 'DSH-Interop' -Force -ErrorAction SilentlyContinue
  Set-Service -Name 'DSH-Interop' -StartupType Disabled -ErrorAction SilentlyContinue
  Write-Output 'disabled the legacy DSH-Interop service'
}
function Ensure-DshService([string]$Name, [string]$Display, [string]$Description, [string]$ExePath) {
  $binPath = '"' + $ExePath + '"'
  if ($null -eq (Get-Service -Name $Name -ErrorAction SilentlyContinue)) {
    & sc.exe create $Name binPath= $binPath start= auto DisplayName= $Display | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc create failed for $Name" }
    & sc.exe description $Name $Description | Out-Null
    & sc.exe failure $Name reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    Write-Output "created service $Name"
  }
  & sc.exe config $Name binPath= $binPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc config failed for $Name" }
}
` + plan.services.map((service) => {
    const command = service.command;
    const display = service.role === "dsh" ? "DSH Web App" : "DSH Mesh Gateway";
    const description = service.role === "dsh" ? "Independent DSH Web process" : "DSH gateway, login and member proxy";
    const source = service.role === "dsh" ? "DshWebAppService.cs" : "DshMeshService.cs";
    return `$exe = Join-Path $New ${ps(command)}
if (-not (Test-Path $exe)) {
  # The package ships the C# service sources, not the binaries, so compile the
  # wrapper into this release with the .NET Framework compiler.
  $serviceSource = Join-Path $New ${ps("code\\windows-service\\" + source)}
  if (-not (Test-Path $serviceSource)) { throw "missing service source: $serviceSource" }
  $csc = Join-Path ([System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
  if (-not (Test-Path $csc)) { throw 'cannot find csc.exe' }
  & $csc /nologo /target:exe /out:$exe /r:System.ServiceProcess.dll $serviceSource
  if ($LASTEXITCODE -ne 0) { throw "csc failed for $exe" }
}
Ensure-DshService ${ps(service.name)} ${ps(display)} ${ps(description)} ($AppRoot + '\\current\\' + ${ps(command)})`;
  }).join("\n");
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Release = ${ps(plan.release)}
$Package = ${ps(plan.remotePackage)}
$New = Join-Path $AppRoot "releases\\$Release"
$Shared = Join-Path $AppRoot 'shared'
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot 'releases') | Out-Null
New-Item -ItemType Directory -Force -Path $Shared | Out-Null
# A failed prepare or activate can leave a whole release tree behind (about
# 1.3 GB each). Keep only the running release and the rollback target; $New is
# excluded because a retry refuses to overwrite it below anyway.
$pruneCurrent = $null
$prunePrevious = $null
if (Test-Path -LiteralPath $Current) {
  $pruneCurrent = (Get-Item -LiteralPath $Current -Force).Target
  if ($pruneCurrent -is [array]) { $pruneCurrent = $pruneCurrent[0] }
}
if (Test-Path -LiteralPath $Previous) {
  $prunePrevious = (Get-Item -LiteralPath $Previous -Force).Target
  if ($prunePrevious -is [array]) { $prunePrevious = $prunePrevious[0] }
}
$pruneTool = Join-Path $Current 'runtime\\node\\node.exe'
Get-ChildItem -LiteralPath (Join-Path $AppRoot 'releases') -Directory |
  Where-Object { $_.FullName -ne $pruneCurrent -and $_.FullName -ne $prunePrevious -and $_.FullName -ne $New } |
  ForEach-Object {
    if (Test-Path -LiteralPath $pruneTool) {
      & $pruneTool -e "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:5,retryDelay:200})" $_.FullName 2>$null
    }
    if (Test-Path -LiteralPath $_.FullName) {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $_.FullName) { Write-Host ("could not remove old release " + $_.Name) }
  }
${plan.preExtracted ? 'if (-not (Test-Path $New)) { throw "release directory missing: $New" }' : 'if (Test-Path $New) { throw "release already exists: $New" }'}
New-Item -ItemType Directory -Force -Path $New | Out-Null
${plan.preExtracted ? "" : "Expand-Archive -LiteralPath $Package -DestinationPath $New -Force"}
$inner = Get-ChildItem -LiteralPath $New -Directory | Select-Object -First 1
if ($inner -and (Test-Path (Join-Path $inner.FullName 'manifest.json'))) {
  Get-ChildItem -LiteralPath $inner.FullName -Force | Move-Item -Destination $New -Force
  Remove-Item -LiteralPath $inner.FullName -Recurse -Force
}
foreach ($dir in @('config','data','home','workspace')) {
  $sharedPath = Join-Path $Shared $dir
  if (-not (Test-Path $sharedPath)) {
    $oldPath = Join-Path $Current $dir
    if (Test-Path $oldPath) { Copy-Item $oldPath $sharedPath -Recurse -Force } else { New-Item -ItemType Directory -Force -Path $sharedPath | Out-Null }
  }
  $newPath = Join-Path $New $dir
  if (Test-Path $newPath) { Remove-Item $newPath -Recurse -Force }
  & cmd.exe /c mklink /J "$newPath" "$sharedPath" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not link $newPath" }
}
$envFile = Join-Path $Shared 'config\\gate.env'
if (-not (Test-Path $envFile)) {
  # First deploy of a fresh machine: create the gateway config that install.ps1
  # would have written, with random secrets, so the split services can start.
  $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $password = ${plan.gatePassword ? ps(plan.gatePassword) : "(-join (1..24 | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] }))"}
  $lines = @(
    '# DeepSeek Harness Web gateway (generated by the first deploy)',
    'DSH_GATE_PORT=${plan.gatePort}',
    'DSH_GATE_BIND=0.0.0.0',
    "DSH_GATE_PASSWORD=$password",
    'DSH_GATE_COOKIE_DAYS=30',
    'DSH_WEB_PORT=31280',
    'DSH_GATE_MEMBER_PORT=${plan.gatePort}',
    'DSH_TRUSTED_HOSTS='
  )
  [System.IO.File]::WriteAllText($envFile, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  Write-Output "generated $envFile (${plan.gatePassword ? "gateway password copied from the deployer" : "gateway password: $password"})"
  try {
    if (-not (Get-NetFirewallRule -DisplayName 'DSH Mesh ${plan.gatePort}' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName 'DSH Mesh ${plan.gatePort}' -Direction Inbound -Protocol TCP -LocalPort ${plan.gatePort} -Action Allow | Out-Null
    }
  } catch { Write-Warning "could not add the firewall rule: $($_.Exception.Message)" }
}
$text = Get-Content -LiteralPath $envFile -Raw
$text = [regex]::Replace($text, '(?m)^DSH_HOME=.*$', "DSH_HOME=$Shared\\home")
$text = [regex]::Replace($text, '(?m)^DSH_WORKDIR=.*$', "DSH_WORKDIR=$Shared\\workspace")
if ($text -notmatch '(?m)^DSH_HOME=') { $text += "\`r\`nDSH_HOME=$Shared\\home" }
if ($text -notmatch '(?m)^DSH_WORKDIR=') { $text += "\`r\`nDSH_WORKDIR=$Shared\\workspace" }
${plan.gatePassword ? `$text = [regex]::Replace($text, '(?m)^DSH_GATE_PASSWORD=.*$', ${psReplacement(`DSH_GATE_PASSWORD=${plan.gatePassword}`)})
if ($text -notmatch '(?m)^DSH_GATE_PASSWORD=') { $text += [Environment]::NewLine + ${ps(`DSH_GATE_PASSWORD=${plan.gatePassword}`)} }
Write-Output 'gateway password synced from the deployer'
` : ""}$text = [regex]::Replace($text, '(?m)^DSH_GATE_CLUSTER_KEY=.*\r?
?', '')
Set-Content -LiteralPath $envFile -Value $text -Encoding utf8 -NoNewline
$node = Join-Path $New 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { throw "missing $node" }
& $node --check (Join-Path $New 'gate\\server.mjs')
if ($LASTEXITCODE -ne 0) { throw 'gate syntax check failed' }
$wireScript = Join-Path $env:TEMP 'dsh-mesh-profile-wire.mjs'
[IO.File]::WriteAllText($wireScript, ${ps(PROFILE_WIRE_SCRIPT)}, [Text.UTF8Encoding]::new($false))
& $node $wireScript (Join-Path $Shared 'home\\profiles\\web') (Join-Path $New 'plugins\\dsh-mesh')${plan.llm === null || plan.llm === void 0 ? "" : " " + [plan.llm.provider, plan.llm.model ?? "", plan.llm.reasoningEffort ?? ""].map((value) => ps(value)).join(" ")}
if ($LASTEXITCODE -ne 0) { throw 'could not wire the dsh-mesh plugin into the DSH profile' }
Remove-Item $wireScript -Force -ErrorAction SilentlyContinue
$credentialsFile = '${plan.remoteCredentials}'
if (Test-Path $credentialsFile) {
  $mergeHelper = Join-Path $New 'shared\\credentials-merge.mjs'
  if (Test-Path ($credentialsFile + '.mjs')) { $mergeHelper = $credentialsFile + '.mjs' }
  & $node $mergeHelper (Join-Path $Shared 'home\\.credentials.yaml') $credentialsFile
  if ($LASTEXITCODE -eq 0) { Remove-Item $credentialsFile, ($credentialsFile + '.mjs') -Force -ErrorAction SilentlyContinue } else { Write-Warning 'could not copy the deployer account sign-in' }
}
${serviceLines}
${plan.interop === null || plan.interop === void 0 ? "" : `# DSH Web hosts the interop listener now; only its configuration belongs
# here: bind the VPN address, reuse the gateway password as the token, and use
# the same model route the deployer uses.
$interopEnv = Join-Path $Shared 'config\\interop.env'
$interopLines = @(
  '# generated by the dsh-mesh deploy',
  "DSH_HOME=$Shared\\home",
  "DSH_WORKDIR=$Shared\\workspace",
  "DSH_INTEROP_BIND=${plan.interop.bind}",
  "DSH_INTEROP_PORT=${plan.interop.port}",
  "DSH_INTEROP_PROVIDER=${plan.interop.provider}",
  "DSH_INTEROP_MODEL=${plan.interop.model}",
  'DSH_INTEROP_APPROVE=1',
  'DSH_INTEROP_USE_GATE_PASSWORD=1'
)
[System.IO.File]::WriteAllText($interopEnv, (($interopLines -join [Environment]::NewLine) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
Write-Output 'wrote config\\interop.env'
`}Write-Output "prepared $Release at $New"
`;
}
function buildWindowsActivateScript(plan) {
  const interopHost = plan.interop === null || plan.interop === void 0 ? null : plan.interop.bind === "0.0.0.0" ? "127.0.0.1" : plan.interop.bind;
  const interopUrl = interopHost === null ? "" : `http://${interopHost}:${plan.interop.port}/healthz`;
  const restart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `Restart-Service -Name ${ps(service.name)} -Force`).join("\n");
  const rollbackRestart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `Restart-Service -Name ${ps(service.name)} -Force -ErrorAction SilentlyContinue`).join("\n");
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Release = ${ps(plan.release)}
$New = Join-Path $AppRoot "releases\\$Release"
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
$port = ${ps(plan.gatePort)}
$interopUrl = ${ps(interopUrl)}
$old = $null
if (Test-Path $Current) {
  $item = Get-Item -LiteralPath $Current -Force
  $old = $item.Target
  if ($old -is [array]) { $old = $old[0] }
}
if ($old) {
  if (Test-Path $Previous) { & cmd.exe /c rmdir "$Previous" | Out-Null }
  & cmd.exe /c mklink /J "$Previous" "$old" | Out-Null
}
if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
& cmd.exe /c mklink /J "$Current" "$New" | Out-Null
if ($LASTEXITCODE -ne 0) {
  # Without the junction the member has no current link at all: put the old one
  # back before failing, or every service definition points at nothing.
  if ($old) { & cmd.exe /c mklink /J "$Current" "$old" | Out-Null }
  throw "could not switch current to $New"
}
function Test-Health {
  $gateOk = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/__gate/health" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { $gateOk = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (-not $gateOk) { return $false }
  if ($interopUrl -ne '') {
    # Let the old stack release :8765 before accepting the new process's marker.
    Start-Sleep -Seconds 10
    for ($i = 0; $i -lt 30; $i++) {
      try {
        $response = Invoke-WebRequest -Uri $interopUrl -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200 -and $response.Content -match 'dsh-mesh-embedded-interop-v1') { return $true }
      } catch { }
      Start-Sleep -Seconds 2
    }
    return $false
  }
  return $true
}
function Test-Health-Loose {
  # A rollback to a release without the embedded listener starts the standalone
  # interop, whose health has no marker. Only the rollback uses this probe.
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/__gate/health" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        if ($interopUrl -eq '') { return $true }
        try {
          $interop = Invoke-WebRequest -Uri $interopUrl -UseBasicParsing -TimeoutSec 3
          if ($interop.StatusCode -eq 200) { return $true }
        } catch { }
      }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}
function Remove-Release([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
  # Never remove the release current points at: a rollback that failed to
  # switch must leave the member on something runnable.
  $active = $null
  if (Test-Path -LiteralPath $Current) {
    $active = (Get-Item -LiteralPath $Current -Force).Target
    if ($active -is [array]) { $active = $active[0] }
  }
  if ($active -eq $Path) { return }
  # Remove-Item cannot delete node_modules paths past MAX_PATH and stops
  # halfway through. Use the active release's Node runtime, never the tree
  # being removed (a running exe cannot delete its own directory).
  $tool = Join-Path $Current 'runtime\\node\\node.exe'
  if (-not (Test-Path -LiteralPath $tool)) { $tool = Join-Path $AppRoot 'current\\runtime\\node\\node.exe' }
  if (Test-Path -LiteralPath $tool) {
    & $tool -e "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:5,retryDelay:200})" $Path 2>$null
  }
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $Path) { Write-Host "could not remove $Path" } else { Write-Host "removed $Path" }
}
# A restart that throws must not skip the health check and the rollback: with
# ErrorActionPreference=Stop it used to abort the script right here, after
# current had already moved.
$restartFailed = $false
try {
${restart}
} catch {
  $restartFailed = $true
  Write-Host ("a service failed to restart on " + $Release + ": " + $_.Exception.Message)
}
function Invoke-Rollback {
  # Logging must not throw here: with ErrorActionPreference=Stop a Write-Error
  # would abort the rollback itself.
  $ErrorActionPreference = 'Continue'
  if (-not $old) {
    Write-Host "no previous release to roll back to; current stays on $Release"
    return
  }
  Write-Host "rolling back to $old"
  if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
  & cmd.exe /c mklink /J "$Current" "$old" | Out-Null
  try {
${rollbackRestart.split("\n").map((line) => `    ${line}`).join("\n")}
  } catch { Write-Host "rollback restart failed: $($_.Exception.Message)" }
  if (Test-Health-Loose) { Write-Host "rollback finished: $old answers the health check" }
  else { Write-Host "rollback finished but $old did not answer the health check; it needs a manual look" }
  # The failed release is no longer referenced; keeping it would leave a full
  # package tree (about 1.3 GB) behind after every failed attempt.
  Remove-Release $New
}
if ($restartFailed -or -not (Test-Health)) {
  if (-not $restartFailed) { Write-Host "health check failed on $Release; rolling back" }
  Invoke-Rollback
  exit 1
}
# Retention: keep the newest N releases and never the current/previous target.
$keep = ${plan.retention}
$currentTarget = $null
$previousTarget = $null
if (Test-Path $Current) { $currentTarget = (Get-Item -LiteralPath $Current -Force).Target }
if (Test-Path $Previous) { $previousTarget = (Get-Item -LiteralPath $Previous -Force).Target }
if ($currentTarget -is [array]) { $currentTarget = $currentTarget[0] }
if ($previousTarget -is [array]) { $previousTarget = $previousTarget[0] }
Get-ChildItem -LiteralPath (Join-Path $AppRoot 'releases') -Directory |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $keep |
  ForEach-Object {
    if ($_.FullName -ne $currentTarget -and $_.FullName -ne $previousTarget) {
      Remove-Release $_.FullName
    }
  }
Write-Output "activated $Release"
`;
}
function buildWindowsRollbackScript(plan) {
  const restart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `Restart-Service -Name ${ps(service.name)} -Force`).join("\n");
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
if (-not (Test-Path $Previous)) { throw 'no previous release to roll back to' }
$old = (Get-Item -LiteralPath $Previous -Force).Target
if ($old -is [array]) { $old = $old[0] }
if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
& cmd.exe /c mklink /J "$Current" "$old" | Out-Null
${restart}
Write-Output "rolled back to $old"
`;
}
function describePlan(plan) {
  return {
    target: {
      host: plan.host,
      user: plan.user ?? null,
      port: plan.port,
      os: plan.os,
      appRoot: plan.appRoot,
      sudo: plan.sudo
    },
    release: plan.release,
    package: plan.package,
    services: plan.services,
    scope: plan.scope,
    steps: [
      `obtain ${path14.basename(plan.package.path)}: download from the release when configured, else upload to ${plan.remotePackage}`,
      `extract and prepare ${plan.releases}/${plan.release} (no service switch)`,
      `update shared config and service definitions for ${plan.appRoot}/current`,
      `switch ${plan.current} to ${plan.release}`,
      ...plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `restart ${service.name} (${service.role})`),
      `health check http://127.0.0.1:${plan.gatePort}/__gate/health`,
      `keep the newest ${plan.retention} releases (current/previous are never deleted)`,
      "on failure switch back to the previous release and restart"
    ]
  };
}
var SshRunner = class {
  /**
   * @param {object} plan deployment plan.
   * @param {{log?: (line: string) => void}} [options] options.
   */
  constructor(plan, options = {}) {
    this.plan = plan;
    this.log = options.log ?? (() => {
    });
  }
  /** @returns {string[]} common SSH options. */
  sshOptions() {
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-p", String(this.plan.port)];
    if (this.plan.identityFile) args.push("-i", this.plan.identityFile);
    return args;
  }
  /** @returns {string} user@host. */
  target() {
    return this.plan.user ? `${this.plan.user}@${this.plan.host}` : this.plan.host;
  }
  /**
   * Upload a local file and report byte progress.
   *
   * The file is streamed through the SSH connection when the target can accept
   * stdin (POSIX `cat` or a PowerShell stdin writer). scp stays as a fallback
   * when streaming fails, so an exotic target still deploys even without a
   * progress meter.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @param {(progress: {bytes:number,totalBytes:number,percent:number,speed:number,indeterminate?:boolean}) => void} [onProgress] progress callback.
   * @returns {Promise<void>}
   */
  async upload(local, remote, onProgress) {
    const totalBytes = (await stat8(local)).size;
    try {
      await this.#uploadStream(local, remote, totalBytes, onProgress);
    } catch (error) {
      this.log(`streamed upload failed (${error instanceof Error ? error.message : String(error)}); retrying with scp`);
      onProgress?.({ bytes: 0, totalBytes, percent: 0, speed: 0, indeterminate: true });
      const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-P", String(this.plan.port)];
      if (this.plan.identityFile) args.push("-i", this.plan.identityFile);
      args.push(local, `${this.target()}:${remote}`);
      try {
        await this.runProcess("scp", args);
      } catch (scpError) {
        await this.runProcess("ssh", [...this.sshOptions(), this.target(), `rm -f -- ${sh(remote)}`]).catch(() => {
        });
        throw scpError;
      }
      onProgress?.({ bytes: totalBytes, totalBytes, percent: 100, speed: 0, indeterminate: false });
    }
  }
  /**
   * Count the entries in a remote archive.
   * @param {string} remote remote archive path.
   * @returns {Promise<number>} entry count.
   */
  async archiveEntries(remote) {
    const { stdout } = await this.runProcess("ssh", [...this.sshOptions(), this.target(), `tar -tf "${remote}"`]);
    return String(stdout).split(/\r?\n/u).filter((line) => line.trim() !== "").length;
  }
  /**
   * Extract a remote archive with the tar that ships with Windows, reporting
   * one callback per extracted entry.
   * @param {string} remote remote archive path.
   * @param {string} target remote directory.
   * @param {() => void} [onEntry] called for every extracted entry.
   * @returns {Promise<void>}
   */
  async extractArchive(remote, target, onEntry) {
    await this.runProcess("ssh", [...this.sshOptions(), this.target(), `cmd /c if not exist "${target}" mkdir "${target}"`]);
    await this.runProcess("ssh", [...this.sshOptions(), this.target(), `tar -xf "${remote}" -C "${target}" -v`], void 0, onEntry, { countOnly: true });
  }
  /**
   * Read a remote file's size, or null when it cannot be read.
   * @param {string} remote remote path.
   * @returns {Promise<number|null>} size in bytes.
   */
  async remoteSize(remote) {
    try {
      const args = [...this.sshOptions(), this.target()];
      let command;
      if (this.plan.os === "windows") {
        const encoded = Buffer.from(`(Get-Item -LiteralPath ${ps(remote)}).Length`, "utf16le").toString("base64");
        command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
      } else {
        command = `stat -c %s -- ${sh(remote)}`;
      }
      const { stdout } = await this.runProcess("ssh", [...args, command]);
      const size = Number.parseInt(String(stdout).trim(), 10);
      return Number.isSafeInteger(size) ? size : null;
    } catch {
      return null;
    }
  }
  /**
   * Free bytes on the filesystem that holds `remote`, or null when it cannot be
   * measured (Windows targets, or a host without `df`).
   * @param {string} remote remote path.
   * @returns {Promise<number|null>} free bytes.
   */
  async remoteFreeBytes(remote) {
    if (this.plan.os !== "linux") return null;
    try {
      const dir = path14.posix.dirname(remote);
      const { stdout } = await this.runProcess("ssh", [...this.sshOptions(), this.target(), `df -Pk -- ${sh(dir)} | awk 'NR==2 {print $4}'`]);
      const kib = Number.parseInt(String(stdout).trim(), 10);
      return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : null;
    } catch {
      return null;
    }
  }
  /**
   * Delete the package archives earlier deploys left beside `remote`.
   *
   * The archive is 300+ MiB and members commonly mount /tmp as a tmpfs (1.7 GB
   * on a 4 GB ECS). Leaving one per job behind made the third or fourth upgrade
   * fail mid-upload with only scp's `write remote ...: Failure` to show for it.
   * @param {string} remote remote path this job is about to upload to.
   * @returns {Promise<boolean>} whether the cleanup command ran.
   */
  async discardStalePackages(remote) {
    if (this.plan.os !== "linux") return false;
    const dir = path14.posix.dirname(remote);
    const keep = path14.posix.basename(remote);
    const script = [
      `cd ${sh(dir)} 2>/dev/null || exit 0`,
      "for f in dsh-mesh-*.gz dsh-mesh-*.tar.gz dsh-mesh-*.zip; do",
      '  [ -e "$f" ] || continue',
      `  [ "$f" = ${sh(keep)} ] && continue`,
      '  rm -f -- "$f"',
      "done",
      "exit 0"
    ].join("\n");
    try {
      await this.runProcess("ssh", [...this.sshOptions(), this.target(), script]);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Stream one file to the remote path through `ssh` stdin.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @param {number} totalBytes file size.
   * @param {Function} [onProgress] progress callback.
   * @returns {Promise<void>}
   */
  async #uploadStream(local, remote, totalBytes, onProgress) {
    const windows = this.plan.os === "windows";
    const remoteCommand = windows ? `tar -xf - -C "${path14.win32.dirname(remote)}"` : `cat > ${sh(remote)}`;
    const args = [...this.sshOptions(), this.target(), remoteCommand];
    let tarDir = null;
    let tarName = null;
    if (windows) {
      tarName = path14.win32.basename(remote);
      tarDir = await mkdtemp5(path14.join(tmpdir3(), "dsh-mesh-upload-"));
      const staged = path14.join(tarDir, tarName);
      try {
        try {
          await link(local, staged);
        } catch {
          await copyFile2(local, staged);
        }
      } catch (error) {
        await rm9(tarDir, { recursive: true, force: true }).catch(() => {
        });
        throw error;
      }
    }
    return new Promise((resolve, reject) => {
      const ssh = spawn5("ssh", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const tar = windows ? spawn5("tar", ["-cf", "-", "-C", tarDir, tarName], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : null;
      const source = tar !== null ? tar.stdout : createReadStream4(local);
      let sent = 0;
      let stderr = "";
      let settled = false;
      let lastAt = Date.now();
      let lastBytes = 0;
      let lastDataAt = Date.now();
      let speed = 0;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        source.destroy();
        tar?.kill("SIGKILL");
        ssh.kill("SIGKILL");
        if (tarDir !== null) void rm9(tarDir, { recursive: true, force: true }).catch(() => {
        });
        if (error) reject(error);
        else resolve();
      };
      const watchdog = setInterval(() => {
        if (Date.now() - lastDataAt > 3e4) {
          finish(new Error("upload stalled: the remote stopped reading stdin (30s without progress)"));
        }
      }, 5e3);
      watchdog.unref?.();
      const report = (force = false) => {
        const now = Date.now();
        if (!force && now - lastAt < 200) return;
        const seconds = Math.max(1, now - lastAt) / 1e3;
        speed = Math.max(0, (sent - lastBytes) / seconds);
        lastAt = now;
        lastBytes = sent;
        const percent = totalBytes > 0 ? Math.min(windows ? 99 : 100, Math.round(sent / totalBytes * 100)) : 0;
        onProgress?.({ bytes: sent, totalBytes, percent, speed, indeterminate: false });
      };
      source.on("data", (chunk) => {
        sent += chunk.length;
        lastDataAt = Date.now();
        report();
      });
      source.once("error", (error) => finish(error));
      ssh.stdout.resume();
      ssh.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      ssh.once("error", (error) => finish(error));
      ssh.once("exit", (code) => {
        if (code === 0) {
          report(true);
          finish();
        } else {
          finish(new Error(`ssh upload exited with ${String(code)}: ${stderr.trim()}`));
        }
      });
      ssh.stdin.once("error", () => {
      });
      if (tar !== null) {
        let tarError = "";
        tar.stderr.on("data", (chunk) => {
          tarError += String(chunk);
        });
        tar.once("error", (error) => finish(error));
        tar.once("exit", (code) => {
          if (code !== 0) finish(new Error(`local tar exited with ${String(code)}: ${tarError.trim()}`));
        });
      }
      source.pipe(ssh.stdin);
    });
  }
  /**
   * Run a local process and reject on a non-zero exit.
   * @param {string} command command.
   * @param {string[]} args arguments.
   * @param {string} [input] stdin.
   * @returns {Promise<{stdout:string,stderr:string}>} output.
   */
  runProcess(command, args, input, onLine, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn5(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const buffers = { out: "", err: "" };
      const emit = (key, chunk) => {
        const text = buffers[key] + String(chunk);
        const lines = text.split(/\r?\n/u);
        buffers[key] = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed !== "") onLine?.(options.countOnly === true ? "" : trimmed);
        }
      };
      const flush = () => {
        for (const key of ["out", "err"]) {
          const trimmed = buffers[key].trim();
          if (trimmed !== "") onLine?.(trimmed);
          buffers[key] = "";
        }
      };
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        emit("out", chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        emit("err", chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        flush();
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim() || stdout.trim()}`));
      });
      if (input !== void 0) child.stdin.end(input);
      else child.stdin.end();
    });
  }
  /**
   * Run a script over SSH.
   * @param {string} script bash or PowerShell script.
   * @param {'linux'|'windows'} os target OS.
   * @returns {Promise<void>}
   */
  async script(script, os9, onLine) {
    const base = this.sshOptions();
    if (os9 === "linux") {
      const remote = this.plan.sudo ? "sudo -n bash -s" : "bash -s";
      await this.runProcess("ssh", [...base, this.target(), remote], script, onLine);
      return;
    }
    const name = `dsh-deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.ps1`;
    const remotePath = `C:\\Windows\\Temp\\${name}`;
    const localPath = path14.join(tmpdir3(), name);
    await writeFile8(localPath, `\uFEFF${script}`, "utf8");
    try {
      await this.upload(localPath, remotePath);
      await this.runProcess(
        "ssh",
        [...base, this.target(), `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remotePath}"`],
        void 0,
        onLine
      );
    } finally {
      await rm9(localPath, { force: true }).catch(() => {
      });
      await this.runProcess("ssh", [...base, this.target(), `cmd /c del /f "${remotePath}"`]).catch(() => {
      });
    }
  }
};
function runLocalProcess(command, args, input, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn5(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const buffers = { out: "", err: "" };
    const emit = (key, chunk) => {
      const text = buffers[key] + String(chunk);
      const lines = text.split(/\r?\n/u);
      buffers[key] = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed !== "") onLine?.(trimmed);
      }
    };
    const flush = () => {
      for (const key of ["out", "err"]) {
        const trimmed = buffers[key].trim();
        if (trimmed !== "") onLine?.(trimmed);
        buffers[key] = "";
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      emit("out", chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      emit("err", chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      flush();
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${String(code)}: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(input ?? "");
  });
}
var LocalRunner = class {
  /**
   * @param {object} plan deployment plan.
   * @param {{log?: (line: string) => void}} [options] options.
   */
  constructor(plan, options = {}) {
    this.plan = plan;
    this.log = options.log ?? (() => {
    });
  }
  /**
   * Copy one file into place, reporting the copy as one finished upload.
   * @param {string} local source path.
   * @param {string} remote destination path.
   * @param {(progress: object) => void} [onProgress] progress callback.
   * @returns {Promise<void>} completion.
   */
  async upload(local, remote, onProgress) {
    const info = await stat8(local);
    await mkdir9(path14.dirname(remote), { recursive: true });
    await copyFile2(local, remote);
    onProgress?.({ bytes: info.size, totalBytes: info.size, percent: 100, speed: 0 });
  }
  /**
   * Size of a local file, or null.
   * @param {string} remote path.
   * @returns {Promise<number|null>} bytes.
   */
  async remoteSize(remote) {
    try {
      const info = await stat8(remote);
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }
  /**
   * Run a bash script in place.
   * @param {string} script script text.
   * @param {'linux'|'windows'} os target OS.
   * @param {(line: string) => void} [onLine] line callback.
   * @returns {Promise<void>} completion.
   */
  async script(script, os9, onLine) {
    if (os9 !== "linux") throw new Error("\u672C\u5730\u90E8\u7F72\u53EA\u652F\u6301 Linux\uFF1A\u672C\u673A\u6CA1\u6709\u53EF\u7528\u7684 Windows \u8FD0\u884C\u65F6");
    await runLocalProcess("bash", ["-s"], script, onLine);
  }
};
function linuxNodeProbeScript(appRoot) {
  const root = String(appRoot ?? "").replace(/[\\/]+$/u, "");
  const candidates = [
    ...root === "" ? [] : [`${root}/current/runtime/node/bin/node`, `${root}/current/runtime/node/node`, `${root}/runtime/node/bin/node`, `${root}/runtime/node/node`],
    "$HOME/.dsh/dsh-mesh/current/runtime/node/bin/node",
    "$HOME/.dsh/dsh-mesh/current/runtime/node/node",
    "$HOME/.dsh/dsh-person-web/current/runtime/node/bin/node"
  ];
  return [
    "for candidate in \\",
    ...candidates.map((value) => `  "${value}" \\`),
    "  ; do",
    '  if [ -x "$candidate" ]; then echo "DSH-MESH-NODE=$candidate"; exit 0; fi',
    "done",
    "found=$(command -v node 2>/dev/null || true)",
    'if [ -n "$found" ]; then echo "DSH-MESH-NODE=$found"; fi',
    ""
  ].join("\n");
}
function windowsNodeProbeScript(appRoot) {
  const root = String(appRoot ?? "").replace(/[\\/]+$/u, "");
  const quoted = root === "" ? [] : [ps(`${root}\\current\\runtime\\node\\node.exe`), ps(`${root}\\runtime\\node\\node.exe`)];
  const candidates = [
    ...quoted,
    "(Join-Path $env:USERPROFILE '.dsh\\dsh-mesh\\current\\runtime\\node\\node.exe')",
    "(Join-Path $env:USERPROFILE '.dsh\\dsh-person-web\\current\\runtime\\node\\node.exe')"
  ];
  return `$ErrorActionPreference = 'Stop'
$candidates = @(
${candidates.map((value) => `  ${value}`).join(",\n")}
)
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { Write-Output ("DSH-MESH-NODE=" + $candidate); exit 0 }
}
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { Write-Output ("DSH-MESH-NODE=" + $cmd.Source) }
`;
}
function normalizeDownloadManifests(download2) {
  if (download2 === null || typeof download2 !== "object") return [];
  const entries = Array.isArray(download2.manifests) ? download2.manifests : [];
  const normalized = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const provider = entry.provider === "github" ? "github" : entry.provider === "gitee" ? "gitee" : "";
    if (provider === "" || typeof entry.url !== "string" || entry.url === "") continue;
    normalized.push({ provider, url: entry.url });
  }
  if (normalized.length > 0) return normalized;
  for (const url of Array.isArray(download2.manifestUrls) ? download2.manifestUrls : []) {
    if (typeof url !== "string" || url === "") continue;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    normalized.push({ provider: /(?:^|\.)github\.com$|githubusercontent\.com$/iu.test(host) ? "github" : "gitee", url });
  }
  return normalized;
}
function releaseDownloadScript(plan, options) {
  const archive = path14.basename(plan.package.path);
  const manifestArgs = options.manifests.map((entry) => `--manifest-${entry.provider} ${plan.os === "windows" ? ps(entry.url) : sh(entry.url)}`).join(" ");
  if (plan.os === "windows") {
    const script2 = `${options.remoteDir}\\deploy\\release-download.mjs`;
    const args2 = [
      manifestArgs,
      `--archive ${ps(archive)}`,
      `--sha256 ${ps(plan.package.sha256)}`,
      `--output ${ps(plan.remotePackage)}`,
      options.proxyUrl === null ? "" : `--proxy ${ps(options.proxyUrl)}`,
      `--workdir ${ps(`${options.remoteDir}\\parts`)}`
    ].filter(Boolean).join(" ");
    return `$ErrorActionPreference = 'Stop'
& ${ps(options.node)} ${ps(script2)} ${args2}
exit $LASTEXITCODE
`;
  }
  const script = `${options.remoteDir}/deploy/release-download.mjs`;
  const args = [
    manifestArgs,
    `--archive ${sh(archive)}`,
    `--sha256 ${sh(plan.package.sha256)}`,
    `--output ${sh(plan.remotePackage)}`,
    options.proxyUrl === null ? "" : `--proxy ${sh(options.proxyUrl)}`,
    `--workdir ${sh(`${options.remoteDir}/parts`)}`
  ].filter(Boolean).join(" ");
  return `set -u
${sh(options.node)} ${sh(script)} ${args}
exit $?
`;
}
function ensureDownloadDirScript(plan, remoteDir) {
  if (plan.os === "windows") {
    return `New-Item -ItemType Directory -Force -Path ${ps(`${remoteDir}\\deploy`)},${ps(`${remoteDir}\\shared`)} | Out-Null
`;
  }
  return `mkdir -p ${sh(`${remoteDir}/deploy`)} ${sh(`${remoteDir}/shared`)}
`;
}
function removeDownloadDirCommand(plan, remoteDir) {
  return plan.os === "windows" ? `cmd /c rmdir /s /q "${remoteDir}"` : `rm -rf ${sh(remoteDir)}`;
}
var DeployManager = class {
  /**
   * @param {{repositoryRoot: string, dataDir: string, log?: (line:string)=>void, runnerFactory?: Function}} options options.
   */
  constructor(options) {
    this.repositoryRoot = options.repositoryRoot;
    this.dataDir = options.dataDir;
    this.logLine = options.log ?? (() => {
    });
    this.runnerFactory = options.runnerFactory ?? ((plan) => plan.local === true ? new LocalRunner(plan, { log: (line) => this.logLine(line) }) : new SshRunner(plan, { log: (line) => this.logLine(line) }));
    this.running = /* @__PURE__ */ new Map();
    this.states = /* @__PURE__ */ new Map();
    this.saves = /* @__PURE__ */ new Map();
    this.writes = /* @__PURE__ */ new Map();
  }
  /** @returns {Promise<void>} no owned process. */
  async dispose() {
  }
  /**
   * Detect the member's existing install root without changing anything.
   * @param {object} request SSH target.
   * @returns {Promise<{appRoot:string,serviceUser:string|undefined}>} detected install.
   */
  async inspectTarget(request) {
    return probeTarget({ ...request });
  }
  /**
   * Plan only; no network.
   * @param {object} request deploy options.
   * @returns {Promise<object>} plan summary.
   */
  async plan(request) {
    const plan = await buildDeployPlan({
      ...request,
      gatePassword: typeof request.gatePassword === "string" ? request.gatePassword : process.env.DSH_GATE_PASSWORD,
      repositoryRoot: this.repositoryRoot
    });
    return { ok: true, plan: describePlan(plan), scripts: request.includeScripts === true ? this.scripts(plan) : void 0 };
  }
  /**
   * Produce all remote scripts for a plan.
   * @param {object} plan plan.
   * @returns {object} scripts.
   */
  scripts(plan) {
    if (plan.os === "linux") {
      return {
        prepare: buildLinuxPrepareScript(plan),
        rehearse: plan.test === true ? buildLinuxRehearseScript(plan) : null,
        activate: buildLinuxActivateScript(plan),
        rollback: buildLinuxRollbackScript(plan)
      };
    }
    return {
      prepare: buildWindowsPrepareScript(plan),
      activate: buildWindowsActivateScript(plan),
      rollback: buildWindowsRollbackScript(plan)
    };
  }
  /**
   * Start a deployment or rollback job.
   *
   * `request.plan` skips the planning step when the caller already built it
   * (the panel does: it needs the release name to write the job that the
   * detached runner then adopts). `request.id` adopts an existing job id the
   * same way, so a spawned runner continues the job the panel created.
   * @param {object} request deploy options.
   * @returns {Promise<object>} job state.
   */
  async start(request) {
    const plan = request.plan !== null && typeof request.plan === "object" ? request.plan : await buildDeployPlan({
      ...request,
      gatePassword: typeof request.gatePassword === "string" ? request.gatePassword : process.env.DSH_GATE_PASSWORD,
      repositoryRoot: this.repositoryRoot
    });
    const id = typeof request.id === "string" && /^deploy-[A-Za-z0-9-]+$/u.test(request.id) ? request.id : newJobId();
    const dir = path14.join(this.dataDir, id);
    await mkdir9(dir, { recursive: true });
    const stateFile = path14.join(dir, "job.json");
    const logFile = path14.join(dir, "deploy.log");
    const state = {
      id,
      // `install`, `upgrade` and `test` run the same phases; the panel only
      // changes the wording, and a job keeps the label it was queued with.
      mode: request.mode === "upgrade" ? "upgrade" : request.mode === "test" ? "test" : "install",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      member: typeof request.member === "string" && request.member !== "" ? request.member : null,
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: plan.release,
      package: plan.package.path,
      services: plan.services.map((service) => service.name),
      status: "running",
      phase: "starting",
      error: null,
      steps: initialDeploySteps({ test: plan.test === true, os: plan.os }),
      progress: { bytes: 0, totalBytes: plan.package.bytes, percent: 0, speed: 0, indeterminate: false }
    };
    if (this.states.size >= 100) {
      const oldest = this.states.keys().next();
      if (!oldest.done) this.states.delete(oldest.value);
    }
    this.states.set(id, state);
    await writeDeployState(dir, state);
    const log = async (line) => {
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      await writeFile8(logFile, `[${stamp}] ${line}
`, { encoding: "utf8", flag: "a" });
      this.logLine(line);
    };
    const task = this.#run(plan, state, stateFile, log);
    this.running.set(id, task);
    task.finally(() => this.running.delete(id)).catch(() => {
    });
    return { ok: true, job: state };
  }
  async #run(plan, state, stateFile, log) {
    const stamp = () => (/* @__PURE__ */ new Date()).toISOString();
    const stepOf = (key) => state.steps.find((item) => item.key === key);
    const mark = async (key, status, detail) => {
      const step = stepOf(key);
      if (step !== void 0) {
        step.status = status;
        if (status === "running" && step.startedAt === null) step.startedAt = stamp();
        if (status === "succeeded" || status === "failed") step.finishedAt = stamp();
        if (typeof detail === "string" && detail !== "") step.detail = detail;
      }
      state.updatedAt = stamp();
      await this.#save(stateFile, state);
    };
    const note = (key, text) => {
      const step = stepOf(key);
      if (step !== void 0) step.detail = text;
      state.updatedAt = stamp();
      void log(text).catch(() => {
      });
    };
    const meter = (label, patch) => {
      state.progress = {
        label,
        percent: 0,
        bytes: 0,
        totalBytes: 0,
        speed: 0,
        done: 0,
        total: 0,
        indeterminate: false,
        ...patch
      };
      state.updatedAt = stamp();
      this.#saveThrottled(stateFile, state);
    };
    try {
      const runner = this.runnerFactory(plan);
      await log(`target ${plan.host} (${plan.os}), release ${plan.release}`);
      await log(`package ${plan.package.path} (${plan.package.sha256.slice(0, 12)}\u2026)`);
      await mark("upload", "running");
      const uploadStarted = Date.now();
      const existingBytes = typeof runner.remoteSize === "function" ? await runner.remoteSize(plan.remotePackage).catch(() => null) : null;
      if (existingBytes === plan.package.bytes) {
        await log(`package already present on the target (${formatBytes2(existingBytes)}), skipping download and upload`);
        meter("\u83B7\u53D6\u5B89\u88C5\u5305", { bytes: existingBytes, totalBytes: plan.package.bytes, percent: 100 });
        await mark("upload", "succeeded", `${formatBytes2(existingBytes)} \xB7 \u5DF2\u5B58\u5728\uFF0C\u8DF3\u8FC7\u4E0B\u8F7D/\u4E0A\u4F20`);
      } else {
        if (typeof runner.discardStalePackages === "function") {
          if (await runner.discardStalePackages(plan.remotePackage).catch(() => false)) {
            await log("pruned package archives left by earlier deploys on the target");
          }
        }
        const freeBytes = typeof runner.remoteFreeBytes === "function" ? await runner.remoteFreeBytes(plan.remotePackage).catch(() => null) : null;
        if (freeBytes !== null) {
          const headroom = plan.download === null ? 64 * 1024 * 1024 : 96 * 1024 * 1024 + 64 * 1024 * 1024;
          const needed = plan.package.bytes + headroom;
          await log(`target free space ${formatBytes2(freeBytes)}, package ${formatBytes2(plan.package.bytes)}, needed ${formatBytes2(needed)}`);
          if (freeBytes < needed) {
            throw new Error(`\u76EE\u6807\u5269\u4F59\u7A7A\u95F4\u4E0D\u8DB3\uFF1A${plan.remotePackage} \u6240\u5728\u5206\u533A\u53EA\u5269 ${formatBytes2(freeBytes)}\uFF0C\u672C\u6B21\u9700\u8981 ${formatBytes2(needed)}\uFF1B\u6E05\u7406\u540E\u91CD\u8BD5`);
          }
        }
        const downloaded = await this.#downloadFromRelease(plan, runner, { log, meter, mark });
        if (!downloaded) {
          await log(`uploading to ${plan.remotePackage}`);
          await runner.upload(plan.package.path, plan.remotePackage, (progress) => {
            const totalBytes = progress.totalBytes ?? plan.package.bytes;
            meter("\u4E0A\u4F20\u5B89\u88C5\u5305", {
              bytes: progress.bytes ?? 0,
              totalBytes,
              percent: progress.percent ?? (totalBytes > 0 ? Math.min(100, Math.round((progress.bytes ?? 0) / totalBytes * 100)) : 0),
              speed: progress.speed ?? 0,
              indeterminate: progress.indeterminate === true
            });
          });
          const uploadSeconds = Math.max(0.1, (Date.now() - uploadStarted) / 1e3);
          meter("\u4E0A\u4F20\u5B89\u88C5\u5305", {
            bytes: plan.package.bytes,
            totalBytes: plan.package.bytes,
            percent: 100,
            speed: plan.package.bytes / uploadSeconds
          });
          await mark("upload", "succeeded", `${formatBytes2(plan.package.bytes)} \xB7 ${uploadSeconds.toFixed(1)}s \xB7 ${formatBytes2(plan.package.bytes / uploadSeconds)}/s`);
        }
      }
      const credentialsFile = deployerCredentialsFile();
      if (credentialsFile !== null) {
        try {
          await runner.upload(credentialsFile, plan.remoteCredentials);
          const helperFile = path14.join(this.repositoryRoot, "code", "shared", "credentials-merge.mjs");
          if (existsSync8(helperFile)) await runner.upload(helperFile, `${plan.remoteCredentials}.mjs`);
          await log("shared the deployer's account sign-in");
        } catch (error) {
          await log(`account sign-in was not shared: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        await log("no deployer account to share (DSH_HOME/.credentials.yaml is missing)");
      }
      if (plan.test === true && plan.os === "linux") {
        state.phase = "rehearse";
        meter("\u6F14\u7EC3\u5E73\u94FA\u5347\u7EA7", { percent: 99, indeterminate: true });
        await mark("rehearse", "running");
        await log("rehearse: run the flat upgrade (backup, copy, wiring, restore) in a sandbox on the member");
        const rehearsed = this.scripts({ ...plan, preExtracted: false });
        await runner.script(rehearsed.rehearse, plan.os, (line) => note("rehearse", line));
        await mark("rehearse", "succeeded");
      }
      state.phase = "prepare";
      await mark("prepare", "running");
      await log("prepare: extract, shared dirs, service definitions (no switch)");
      let preExtracted = false;
      const prepareStep = stepOf("prepare");
      let entries = 0;
      const extractProgress = (done, total, finished2 = false) => {
        const percent = total > 0 ? finished2 ? 100 : Math.min(99, Math.round(done / total * 100)) : 0;
        if (prepareStep !== void 0) prepareStep.progress = { done, total, percent };
        meter("\u89E3\u538B\u5B89\u88C5\u5305", { done, total, percent, indeterminate: total === 0 });
      };
      const trackExtract = (line) => {
        const text = line.trim();
        const head = /^DSH-MESH-EXTRACT-TOTAL (\d+)$/u.exec(text);
        if (head !== null) {
          entries = Number.parseInt(head[1], 10);
          extractProgress(0, entries);
          return true;
        }
        const tick = /^DSH-MESH-EXTRACT (\d+)$/u.exec(text);
        if (tick !== null) {
          const done = Number.parseInt(tick[1], 10);
          extractProgress(entries > 0 ? Math.min(done, entries) : done, entries);
          return true;
        }
        return false;
      };
      if (plan.os === "windows" && typeof runner.archiveEntries === "function" && typeof runner.extractArchive === "function") {
        const newDir = `${plan.releases}\\${plan.release}`;
        const total = await runner.archiveEntries(plan.remotePackage).catch(() => 0);
        if (total > 0) {
          await log(`extracting ${total} archive entries with tar`);
          let done = 0;
          await runner.extractArchive(plan.remotePackage, newDir, () => {
            done += 1;
            if (done % 500 === 0 || done === total) extractProgress(done, total);
          });
          extractProgress(total, total, true);
          preExtracted = true;
        }
      }
      const scripts = this.scripts({ ...plan, preExtracted });
      await runner.script(scripts.prepare, plan.os, (line) => {
        if (trackExtract(line)) return;
        note("prepare", line);
      });
      if (plan.os === "linux" && entries > 0) extractProgress(entries, entries, true);
      await mark("prepare", "succeeded");
      state.phase = "activate";
      meter("\u5207\u6362\u5E76\u91CD\u542F\u670D\u52A1", { percent: 99, indeterminate: true });
      await mark("activate", "running");
      await log("activate: switch current, restart services with the gateway last");
      await runner.script(scripts.activate, plan.os, (line) => note("activate", line));
      await mark("activate", "succeeded");
      meter("\u5207\u6362\u5E76\u91CD\u542F\u670D\u52A1", { ...state.progress, percent: 100, indeterminate: false });
      state.status = "succeeded";
      state.phase = "done";
      state.updatedAt = stamp();
      await this.#save(stateFile, state);
      await log("deployment succeeded");
    } catch (error) {
      state.status = "failed";
      state.phase = "failed";
      state.error = describeDeployFailure(error instanceof Error ? error.message : String(error));
      state.updatedAt = stamp();
      const active = state.steps.find((item) => item.status === "running");
      if (active !== void 0) {
        active.status = "failed";
        active.finishedAt = stamp();
      }
      await this.#save(stateFile, state).catch(() => {
      });
      await log(`deployment failed: ${state.error}`).catch(() => {
      });
    } finally {
      this.running.delete(state.id);
    }
  }
  /**
   * Try to fetch the package on the member from the configured release.
   *
   * Nothing here is fatal: a missing runtime, an unreachable release, a bad
   * proxy, or a checksum mismatch all return false and the caller falls back
   * to the gateway upload. That keeps a release outage from blocking an
   * upgrade while still making the release the default path.
   * @param {object} plan deployment plan.
   * @param {object} runner SSH runner.
   * @param {{log: Function, meter: Function, mark: Function}} hooks progress sinks.
   * @returns {Promise<boolean>} whether the verified package is on the target.
   */
  async #downloadFromRelease(plan, runner, hooks) {
    const { log, meter, mark } = hooks;
    const download2 = plan.download;
    if (download2 === null || typeof download2 !== "object") return false;
    const manifests = normalizeDownloadManifests(download2);
    if (manifests.length === 0) return false;
    const suffix = plan.package.sha256.slice(0, 12);
    const remoteDir = plan.os === "windows" ? `C:\\Windows\\Temp\\dsh-mesh-release-${suffix}` : `/tmp/dsh-mesh-release-${suffix}`;
    let egress = null;
    let proxyUrl = null;
    try {
      const node = await this.#findTargetNode(plan, runner);
      if (node === "") {
        await log("release download skipped: the target has no Node runtime to run the downloader");
        return false;
      }
      const localDownloader = path14.join(this.repositoryRoot, "code", "deploy", "release-download.mjs");
      const localClient = path14.join(this.repositoryRoot, "code", "shared", "http-client.mjs");
      if (!existsSync8(localDownloader) || !existsSync8(localClient)) {
        await log("release download skipped: the downloader files are missing from this plugin installation");
        return false;
      }
      if (plan.os === "windows") {
        await runner.script(ensureDownloadDirScript(plan, remoteDir), "windows");
      } else {
        await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), ensureDownloadDirScript(plan, remoteDir)]);
      }
      const join = (name) => plan.os === "windows" ? `${remoteDir}\\${name.replace(/\//gu, "\\")}` : `${remoteDir}/${name}`;
      await runner.upload(localDownloader, join("deploy/release-download.mjs"));
      await runner.upload(localClient, join("shared/http-client.mjs"));
      const needsProxy = manifests.some((entry) => entry.provider === "github");
      if (download2.proxy !== null && typeof download2.proxy === "object" && needsProxy) {
        try {
          egress = new EgressProxy({ log: (line) => {
            void log(`download proxy: ${line}`);
          } });
          const started = await egress.start({ plan: download2.proxy, member: download2.proxy.name ?? download2.proxy.host });
          proxyUrl = started.url;
          await log(`release download through ${download2.proxy.name ?? download2.proxy.host} proxy (${proxyUrl}); Gitee is fetched directly`);
        } catch (error) {
          egress?.closeAll();
          egress = null;
          proxyUrl = null;
          await log(`download proxy unavailable (${error instanceof Error ? error.message : String(error)}); trying a direct release download`);
        }
      } else if (download2.proxy !== null && typeof download2.proxy === "object") {
        await log("release download has only Gitee manifests; the proxy is not used");
      } else {
        await log("release download has no proxy configured; GitHub and Gitee are both fetched directly");
      }
      meter("\u4ECE Release \u4E0B\u8F7D\u5B89\u88C5\u5305", { percent: 0, indeterminate: true });
      const script = releaseDownloadScript(plan, { node, remoteDir, manifests, proxyUrl });
      let total = plan.package.bytes;
      let bytes = 0;
      let source = "";
      let speed = 0;
      let lastAt = Date.now();
      let lastBytes = 0;
      const startedAt = Date.now();
      let failure = null;
      try {
        await runner.script(script, plan.os, (line) => {
          const planMatch = /^DSH-MESH-DOWNLOAD-PLAN (\d+)$/u.exec(line);
          if (planMatch !== null) {
            total = Number.parseInt(planMatch[1], 10) || total;
            return;
          }
          const manifestMatch = /^DSH-MESH-DOWNLOAD-MANIFEST (\S+) (\S+)$/u.exec(line);
          if (manifestMatch !== null) {
            void log(`release manifest ${manifestMatch[1]}: ${manifestMatch[2]}`);
            return;
          }
          const sourceMatch = /^DSH-MESH-DOWNLOAD-SOURCE (github|gitee)$/u.exec(line);
          if (sourceMatch !== null) {
            source = sourceMatch[1] === "gitee" ? "Gitee Release" : "GitHub Release";
            return;
          }
          const progressMatch = /^DSH-MESH-DOWNLOAD (\d+) (\d+)$/u.exec(line);
          if (progressMatch !== null) {
            bytes = Number.parseInt(progressMatch[1], 10);
            total = Number.parseInt(progressMatch[2], 10) || total;
            const now = Date.now();
            const seconds = Math.max(1e-3, (now - lastAt) / 1e3);
            speed = bytes >= lastBytes ? (bytes - lastBytes) / seconds : 0;
            lastAt = now;
            lastBytes = bytes;
            meter("\u4ECE Release \u4E0B\u8F7D\u5B89\u88C5\u5305", {
              bytes,
              totalBytes: total,
              percent: total > 0 ? Math.min(100, Math.round(bytes / total * 100)) : 0,
              speed
            });
            return;
          }
          if (/^DSH-MESH-DOWNLOAD-(?:OK|PART|DONE|PROGRESS) /u.test(line)) return;
          void log(line);
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      const landed = typeof runner.remoteSize === "function" ? await runner.remoteSize(plan.remotePackage).catch(() => null) : null;
      if (failure === null && landed === plan.package.bytes) {
        const seconds = Math.max(0.1, (Date.now() - startedAt) / 1e3);
        const via = source === "Gitee Release" ? "Gitee \u76F4\u8FDE" : proxyUrl === null ? "GitHub \u76F4\u8FDE" : `GitHub \u7ECF ${download2.proxy?.name ?? download2.proxy?.host ?? "\u5916\u7F51\u4E3B\u673A"} \u4EE3\u7406`;
        meter("\u4ECE Release \u4E0B\u8F7D\u5B89\u88C5\u5305", { bytes: landed, totalBytes: landed, percent: 100, speed: landed / seconds });
        await mark("upload", "succeeded", `${formatBytes2(landed)} \xB7 ${source === "" ? "Release" : source} \u4E0B\u8F7D\uFF08${via}\uFF09${seconds.toFixed(1)}s \xB7 ${formatBytes2(landed / seconds)}/s`);
        await log(`downloaded the package from ${source === "" ? "the release" : source} (${via})`);
        return true;
      }
      await log(`release download did not produce a usable package (${failure ?? `size ${String(landed)} instead of ${String(plan.package.bytes)}`}); falling back to a gateway upload`);
      return false;
    } catch (error) {
      await log(`release download failed (${error instanceof Error ? error.message : String(error)}); falling back to a gateway upload`);
      return false;
    } finally {
      egress?.closeAll();
      await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), removeDownloadDirCommand(plan, remoteDir)]).catch(() => {
      });
    }
  }
  /**
   * Locate a Node runtime on the target without assuming the service user's home.
   * @param {object} plan deployment plan.
   * @param {object} runner SSH runner.
   * @returns {Promise<string>} absolute path or ''.
   */
  async #findTargetNode(plan, runner) {
    let node = "";
    const script = plan.os === "windows" ? windowsNodeProbeScript(plan.appRoot) : linuxNodeProbeScript(plan.appRoot);
    await runner.script(script, plan.os, (line) => {
      const match = /^DSH-MESH-NODE=(.+)$/u.exec(line.trim());
      if (match !== null && node === "") node = match[1].trim();
    }).catch(() => {
    });
    return node;
  }
  /**
   * Persist upload progress at most a few times per second.
   * @param {string} stateFile job state file.
   * @param {object} state job state.
   * @returns {void}
   */
  #saveThrottled(stateFile, state) {
    const now = Date.now();
    if (now - (this.saves.get(state.id) ?? 0) < 300) return;
    this.saves.set(state.id, now);
    void this.#save(stateFile, state).catch(() => {
    });
  }
  async #save(stateFile, state) {
    const text = `${JSON.stringify(state, null, 2)}
`;
    const tmp = `${stateFile}.${process.pid}.tmp`;
    const previous = this.writes.get(stateFile) ?? Promise.resolve();
    const next = previous.catch(() => {
    }).then(async () => {
      await writeFile8(tmp, text, "utf8");
      await rename6(tmp, stateFile);
    });
    this.writes.set(stateFile, next.catch(() => {
    }));
    await next;
  }
  /**
   * Finalize a job whose runner is gone: the process restarted, or a stale
   * snapshot survived a crash.
   *
   * A job is live while its promise is tracked *in this process*, and also
   * while the runner that owns it is still alive: jobs started by the panel run
   * in a detached process on purpose, so this process (the panel) usually does
   * not hold their promise. Only when both are gone is the job reported as
   * interrupted instead of a failure.
   * @param {object} state job state read from disk.
   * @returns {Promise<object>} settled state.
   */
  async #settle(state) {
    if (state === null || typeof state !== "object") return state;
    if (state.status !== "running" && state.status !== "queued") return state;
    if (this.running.has(state.id)) return state;
    const dir = path14.join(this.dataDir, state.id);
    const runner = await runnerStatus(dir);
    if (runner.alive) return state;
    if (runner.runner === null) {
      const created = Date.parse(String(state.createdAt ?? ""));
      if (!Number.isFinite(created) || Date.now() - created < RUNNER_START_GRACE_MS) return state;
    }
    if (state.status === "queued") {
      const created = Date.parse(String(state.createdAt ?? ""));
      if (Number.isFinite(created) && Date.now() - created < RUNNER_START_GRACE_MS) return state;
    }
    const log = await this.logs(state.id, 400).catch(() => "");
    const tail = log.split("\n").filter((line) => line.trim() !== "").slice(-5).join("\n");
    if (/deployment succeeded/u.test(tail)) {
      state.status = "succeeded";
      state.phase = "done";
      state.progress = { ...state.progress ?? {}, percent: 100, indeterminate: false };
      for (const step of state.steps ?? []) {
        if (step?.status === "running") step.status = "succeeded";
      }
    } else if (/deployment failed: (?<reason>.+)$/mu.test(tail)) {
      state.status = "failed";
      state.phase = "failed";
      state.error = state.error ?? (/deployment failed: (?<reason>.+)$/mu.exec(tail)?.groups?.reason?.trim() ?? "deployment failed");
    } else {
      state.status = "failed";
      state.phase = "failed";
      state.error = state.error ?? "deployment was interrupted before it finished";
      const why = runner.runner === null ? "runner.json was unreadable" : `runner pid ${String(runner.runner.pid)} is gone`;
      await appendDeployLog(dir, `settle: no live runner (${why}); the job is marked failed`).catch(() => {
      });
    }
    state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await this.#save(path14.join(dir, "job.json"), state).catch(() => {
    });
    return state;
  }
  /**
   * Wait for one running deployment or rollback job to settle.
   * @param {string} id job id.
   * @returns {Promise<object|null>} final job state.
   */
  async wait(id) {
    const running = this.running.get(id);
    if (running !== void 0) await running;
    return this.status(id);
  }
  /**
   * Read a job.
   * @param {string} id job id.
   * @returns {Promise<object|null>} state.
   */
  async status(id) {
    if (typeof id !== "string" || !/^deploy-[A-Za-z0-9-]+$/.test(id)) return null;
    const live = this.states.get(id);
    if (live !== void 0) return live;
    try {
      const stored = JSON.parse(await readFile11(path14.join(this.dataDir, id, "job.json"), "utf8"));
      return await this.#settle(stored);
    } catch {
      return null;
    }
  }
  /**
   * List recent deployment jobs, newest first.
   * @param {number} [limit] maximum number of jobs.
   * @returns {Promise<object[]>} jobs.
   */
  async list(limit = 20) {
    const jobs = [];
    let entries = [];
    try {
      entries = await readdir5(this.dataDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("deploy-")) continue;
      try {
        const stored = JSON.parse(await readFile11(path14.join(this.dataDir, entry.name, "job.json"), "utf8"));
        jobs.push(await this.#settle(stored));
      } catch {
      }
    }
    for (const [id, live] of this.states) {
      if (!jobs.some((job) => job.id === id)) jobs.push(live);
    }
    jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return jobs.slice(0, Math.max(1, Math.min(limit, 100)));
  }
  /**
   * Tail a job log.
   * @param {string} id job id.
   * @param {number} lines line count.
   * @returns {Promise<string>} log tail.
   */
  async logs(id, lines = 80) {
    if (typeof id !== "string" || !/^deploy-[A-Za-z0-9-]+$/.test(id)) return "";
    try {
      const text = await readFile11(path14.join(this.dataDir, id, "deploy.log"), "utf8");
      return text.split("\n").slice(-Math.max(1, Math.min(lines, 500))).join("\n");
    } catch {
      return "";
    }
  }
  /**
   * Roll back to the previous release.
   * @param {object} request deploy options (target and appRoot are enough).
   * @returns {Promise<object>} job.
   */
  async rollback(request) {
    const plan = await buildDeployPlan({ ...request, repositoryRoot: this.repositoryRoot, skipPackage: true });
    const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path14.join(this.dataDir, id);
    await mkdir9(dir, { recursive: true });
    const stateFile = path14.join(dir, "job.json");
    const logFile = path14.join(dir, "deploy.log");
    const state = {
      id,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: "rollback",
      status: "running",
      phase: "rollback",
      error: null
    };
    await writeFile8(stateFile, `${JSON.stringify(state, null, 2)}
`, "utf8");
    const log = async (line) => {
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      await writeFile8(logFile, `[${stamp}] ${line}
`, { encoding: "utf8", flag: "a" });
      this.logLine(line);
    };
    const task = (async () => {
      try {
        const runner = this.runnerFactory(plan);
        await log("rolling back to the previous release");
        await runner.script(this.scripts(plan).rollback, plan.os);
        state.status = "succeeded";
        state.phase = "done";
      } catch (error) {
        state.status = "failed";
        state.phase = "failed";
        state.error = describeDeployFailure(error instanceof Error ? error.message : String(error));
      }
      await this.#save(stateFile, state);
      await log(state.status === "succeeded" ? "rollback succeeded" : `rollback failed: ${state.error}`);
    })();
    this.running.set(id, task);
    task.finally(() => this.running.delete(id)).catch(() => {
    });
    return { ok: true, job: state };
  }
};

// src/lib/remote-build.mjs
import { createHash as createHash4 } from "node:crypto";
import { mkdtemp as mkdtemp6, open as open3, rename as rename7, rm as rm10, stat as stat9, writeFile as writeFile9 } from "node:fs/promises";
import { tmpdir as tmpdir4 } from "node:os";
import path15 from "node:path";
var DEFAULT_MESH_REPO = "https://github.com/Cangjier/dsh-mesh.git";
var REMOTE_SRC = "$HOME/.dsh/mesh/build-src";
var REMOTE_JOBS = "$HOME/.dsh/mesh/build";
var REMOTE_BIN = "$HOME/.dsh/mesh/bin";
var REMOTE_NODE_DIR = "$HOME/.dsh/dsh-mesh/current/runtime/node/bin";
function publishArgument(options) {
  if (options.publish === false) return " --no-publish";
  if (typeof options.releaseConfigRemote === "string" && options.releaseConfigRemote !== "") {
    return ` --release-config ${quote(options.releaseConfigRemote)}`;
  }
  return " --no-publish";
}
function remoteBuildScript(options) {
  const ref = String(options.ref);
  const targets = options.targets.join(",");
  const out = `${REMOTE_JOBS}/${options.jobId}`;
  const heap = Number.isSafeInteger(options.heapMb) && options.heapMb > 0 ? options.heapMb : 2048;
  const needGiB = 5 + 3 * options.targets.length;
  const lines = [
    "set -u",
    `export PATH="${REMOTE_BIN}:${REMOTE_NODE_DIR}:$PATH"`,
    "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    "export CI=1",
    `export NODE_OPTIONS="--max-old-space-size=${String(heap)}"`,
    options.proxyUrl ? `export HTTP_PROXY=${quote(options.proxyUrl)} HTTPS_PROXY=${quote(options.proxyUrl)} npm_config_proxy=${quote(options.proxyUrl)} npm_config_https_proxy=${quote(options.proxyUrl)}` : "",
    `mkdir -p ${REMOTE_BIN} ${out}`,
    // Finished jobs from earlier builds are what fill a member's disk: a
    // two-target job keeps its own source tree and both package trees. The
    // gateway keeps the state and the log, so the member-side directory is
    // only ever needed while that build runs.
    `find "${REMOTE_JOBS}" -mindepth 1 -maxdepth 1 -type d ! -name ${quote(String(options.jobId))} -exec rm -rf {} + 2>/dev/null || true`,
    `free_kb=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')`,
    `if [ "\${free_kb:-0}" -lt ${String(needGiB * 1024 * 1024)} ]; then echo "not enough free space on the build host: \${free_kb:-0} KiB free, ${String(needGiB)} GiB needed" >&2; exit 4; fi`,
    `if [ ! -d "${REMOTE_SRC}/.git" ]; then`,
    `  echo "cloning ${options.repoUrl ?? DEFAULT_MESH_REPO}"`,
    `  git clone --depth 1 --branch main ${quote(options.repoUrl ?? DEFAULT_MESH_REPO)} "${REMOTE_SRC}" || { echo "mesh clone failed" >&2; exit 3; }`,
    "else",
    `  git -C "${REMOTE_SRC}" fetch --depth 1 origin main && git -C "${REMOTE_SRC}" reset --hard FETCH_HEAD || { echo "mesh update failed" >&2; exit 3; }`,
    "fi",
    'corepack enable --install-directory "$HOME/.dsh/mesh/bin" >/dev/null 2>&1 || true',
    `cd "${REMOTE_SRC}" || { echo "mesh checkout is missing" >&2; exit 3; }`,
    'echo "mesh head $(git rev-parse --short HEAD)"',
    `"${REMOTE_NODE_DIR}/node" code/build/cli.mjs build --stream --out "${out}" --ref ${quote(ref)} --targets ${quote(targets)}${options.buildStamp ? ` --build-stamp ${quote(options.buildStamp)}` : ""}${options.proxyUrl ? ` --proxy ${quote(options.proxyUrl)}` : ""}${publishArgument(options)}`,
    "code=$?",
    `ls -1d "${out}"/* 2>/dev/null | head -n 5`,
    "exit $code",
    ""
  ];
  return lines.filter((line) => line !== "").join("\n");
}
function quote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}
function windowsBuildScript(options) {
  const repo = options.repoUrl ?? DEFAULT_MESH_REPO;
  const needGiB = 5 + 3 * options.targets.length;
  const codeload = repo.replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/^https:\/\/github\.com\//u, "https://codeload.github.com/").replace(/\/+$/u, "");
  const zipUrl = `${codeload}/zip/refs/heads/main`;
  const heap = Number.isSafeInteger(options.heapMb) && options.heapMb > 0 ? options.heapMb : 4096;
  const proxy2 = typeof options.proxyUrl === "string" ? options.proxyUrl.trim() : "";
  const proxyArgument = proxy2 === "" ? "" : ` -Proxy ${quotePs(proxy2)}`;
  const appRoot = String(options.appRoot ?? "").replace(/[\\/]+$/u, "");
  const candidates = [
    ...appRoot === "" ? [] : [quotePs(`${appRoot}\\runtime\\node`)],
    '"$env:USERPROFILE\\.dsh\\dsh-mesh\\current\\runtime\\node"',
    '"$env:USERPROFILE\\.dsh\\dsh-person-web\\runtime\\node"',
    '"$env:ProgramFiles\\nodejs"'
  ];
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$root = Join-Path $env:USERPROFILE '.dsh\\mesh'",
    "$src = Join-Path $root 'build-src'",
    "$bin = Join-Path $root 'bin'",
    `$out = Join-Path $root 'build\\${options.jobId}'`,
    "New-Item -ItemType Directory -Force -Path $out, $bin | Out-Null",
    "$nodeDir = $null",
    `foreach ($candidate in @(${candidates.join(", ")})) { if (Test-Path (Join-Path $candidate 'node.exe')) { $nodeDir = $candidate; break } }`,
    "if ($null -eq $nodeDir) { throw 'no node runtime on this member' }",
    // Remove last run's job directory with Node instead of Remove-Item:
    // node_modules paths are longer than MAX_PATH and Remove-Item fails on
    // them halfway through, which is exactly how a member's disk filled up.
    "$buildRoot = Join-Path $root 'build'",
    `$rmScript = "const fs=require('fs');const p=process.argv[1];fs.rmSync(p,{recursive:true,force:true,maxRetries:5,retryDelay:200})"`,
    `Get-ChildItem -LiteralPath $buildRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne ${quotePs(String(options.jobId))} } | ForEach-Object { & (Join-Path $nodeDir 'node.exe') -e $rmScript $_.FullName 2>$null; if (Test-Path -LiteralPath $_.FullName) { Write-Output ('could not remove a leftover job dir: ' + $_.Name) } }`,
    "$driveFree = 0",
    "try { $driveFree = (Get-PSDrive ((Get-Item $env:USERPROFILE).PSDrive.Name)).Free } catch { $driveFree = (Get-PSDrive C).Free }",
    `if ($driveFree -lt ${String(needGiB * 1024 ** 3)}) { throw ("not enough free space on the build host: {0:N1} GiB free, ${String(needGiB)} GiB needed" -f ($driveFree / 1GB)) }`,
    '$env:PATH = "$bin;$nodeDir;$env:PATH"',
    "$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'",
    "$env:CI = '1'",
    `$env:NODE_OPTIONS = '--max-old-space-size=${String(heap)}'`,
    proxy2 === "" ? "" : `$env:HTTP_PROXY = ${quotePs(proxy2)}; $env:HTTPS_PROXY = $env:HTTP_PROXY`,
    "Write-Output 'downloading the dsh-mesh checkout'",
    // A zip + Expand-Archive instead of the tar.gz: Windows' bsdtar fails on
    // the repository's Chinese doc names ("Invalid empty pathname"), while
    // .NET's zip reader keeps UTF-8 names intact.
    '$archive = Join-Path $root "dsh-mesh.zip"',
    `$curl = Join-Path $env:SystemRoot 'System32\\curl.exe'`,
    // A single reset on the tunnel used to fail the whole nightly build, so the
    // archive is fetched a few times with a growing pause in between. A failed
    // attempt deletes its partial file: a truncated zip must never reach
    // Expand-Archive, which would otherwise fail with a misleading message.
    "$attempts = 4",
    "$downloadCode = 1",
    "for ($attempt = 1; $attempt -le $attempts; $attempt++) {",
    "  Remove-Item -Force $archive -ErrorAction SilentlyContinue",
    `  if (Test-Path $curl) { & $curl -fsSL --connect-timeout 20${proxy2 === "" ? "" : ` --proxy ${quotePs(proxy2)}`} -o $archive '${zipUrl}'; $downloadCode = $LASTEXITCODE } else { try { Invoke-WebRequest -Uri '${zipUrl}' -OutFile $archive -UseBasicParsing${proxyArgument}; $downloadCode = 0 } catch { $downloadCode = 1; Write-Output ('download error: ' + $_.Exception.Message) } }`,
    "  if ($downloadCode -eq 0 -and (Test-Path $archive)) { break }",
    `  Write-Output ('download attempt {0}/{1} failed ({2})' -f $attempt, $attempts, $downloadCode)`,
    "  if ($attempt -lt $attempts) { Start-Sleep -Seconds (3 * $attempt) }",
    "}",
    'if ($downloadCode -ne 0 -or -not (Test-Path $archive)) { throw "mesh download failed ($downloadCode)" }',
    '$extract = Join-Path $root "extract"',
    "Remove-Item -Recurse -Force $src, $extract -ErrorAction SilentlyContinue",
    "New-Item -ItemType Directory -Force -Path $extract | Out-Null",
    "Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force",
    "$inner = Get-ChildItem -Directory $extract | Select-Object -First 1",
    'if ($null -eq $inner) { throw "mesh archive had no top-level directory" }',
    "New-Item -ItemType Directory -Force -Path $src | Out-Null",
    'Move-Item -Path (Join-Path $inner.FullName "*") -Destination $src -Force',
    "Remove-Item -Recurse -Force $extract, $archive -ErrorAction SilentlyContinue",
    'if (-not (Test-Path (Join-Path $src "code\\build\\cli.mjs"))) { throw "mesh checkout is incomplete" }',
    `& (Join-Path $nodeDir 'corepack.cmd') enable --install-directory $bin | Out-Null`,
    "Set-Location $src",
    `& (Join-Path $nodeDir 'node.exe') code/build/cli.mjs build --stream --out $out --ref ${quotePs(options.ref)} --targets ${quotePs(options.targets.join(","))}${options.buildStamp ? ` --build-stamp ${quotePs(options.buildStamp)}` : ""}${proxy2 === "" ? "" : ` --proxy ${quotePs(proxy2)}`}${windowsPublishArgument(options)}`,
    "$code = $LASTEXITCODE",
    "Get-ChildItem -Directory $out -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty FullName",
    "exit $code",
    ""
  ].filter((line) => line !== "").join("\r\n");
}
function windowsTempDir(appRoot) {
  const match = /^([A-Za-z]:\\Users\\[^\\]+)/u.exec(String(appRoot ?? ""));
  return match === null ? "C:\\Windows\\Temp" : `${match[1]}\\AppData\\Local\\Temp`;
}
function windowsPublishArgument(options) {
  if (options.publish === false) return " --no-publish";
  if (typeof options.releaseConfigRemote === "string" && options.releaseConfigRemote !== "") {
    return ` --release-config ${quotePs(options.releaseConfigRemote)}`;
  }
  return " --no-publish";
}
function quotePs(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}
function decodeWindowsState(stdout) {
  const runs = String(stdout).match(/[A-Za-z0-9+/=]{16,}/gu) ?? [];
  const encoded = runs.reduce((best, run2) => run2.length > best.length ? run2 : best, "");
  const text = Buffer.from(encoded, "base64").toString("utf8");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}
function powershellCommand(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}
async function sha256File3(file) {
  const hash = createHash4("sha256");
  const handle = await open3(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
var RemoteBuilder = class {
  /**
   * @param {{log?: (line: string) => void, packagesDir: string}} options options.
   */
  constructor(options) {
    this.log = options.log ?? (() => {
    });
    this.packagesDir = options.packagesDir;
    this.writes = Promise.resolve();
  }
  /**
   * Run one job on a member and settle the local job state.
   * @param {string} jobDir local job directory.
   * @param {{plan: {os?: string, appRoot?: string}, memberName: string, proxyUrl?: string|null, repoUrl?: string, buildStamp?: string, heapMb?: number, releaseConfig?: object|null}} options run options.
   * @returns {Promise<object>} final local state.
   */
  async run(jobDir, options) {
    const state = await readState(jobDir);
    await this.#update(jobDir, { status: "running", phase: "prepare", percent: 1, error: null });
    const runner = new SshRunner({ port: 22, ...options.plan }, { log: (line) => this.log(`remote ${state.member ?? ""}: ${line}`) });
    const windows = options.plan.os === "windows";
    let releaseConfigRemote = options.releaseConfig === null || options.releaseConfig === void 0 ? null : windows ? `${windowsTempDir(options.plan.appRoot)}\\dsh-mesh-release-${state.id}.json` : `/tmp/dsh-mesh-release-${state.id}.json`;
    if (releaseConfigRemote !== null) {
      try {
        await this.#uploadReleaseConfig(runner, options.releaseConfig, releaseConfigRemote, windows);
        await appendLog(jobDir, `release config shipped to ${releaseConfigRemote}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendLog(jobDir, `could not ship the release config; this build will not publish: ${message}`);
        releaseConfigRemote = null;
      }
    }
    const script = windows ? windowsBuildScript({
      jobId: state.id,
      ref: state.ref,
      targets: state.targets,
      proxyUrl: options.proxyUrl,
      repoUrl: options.repoUrl,
      buildStamp: options.buildStamp,
      heapMb: options.heapMb,
      appRoot: options.plan.appRoot,
      releaseConfigRemote,
      publish: releaseConfigRemote !== null
    }) : remoteBuildScript({
      jobId: state.id,
      ref: state.ref,
      targets: state.targets,
      proxyUrl: options.proxyUrl,
      repoUrl: options.repoUrl,
      buildStamp: options.buildStamp,
      heapMb: options.heapMb,
      releaseConfigRemote,
      publish: releaseConfigRemote !== null
    });
    let percent = 1;
    const onLine = (line) => {
      void appendLog(jobDir, line);
      const update = phaseFromLine(line, state.targets);
      if (update === null) return;
      const patch = { phase: update.phase };
      if (typeof update.percent === "number" && update.percent > percent) {
        percent = update.percent;
        patch.percent = percent;
      }
      if (update.currentTarget !== void 0) patch.currentTarget = update.currentTarget;
      void this.#update(jobDir, patch);
    };
    try {
      await runner.script(script, windows ? "windows" : "linux", onLine);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(jobDir, `member build did not finish: ${message}`);
      const settled = await this.#update(jobDir, { status: "failed", phase: "failed", error: message, percent });
      await this.#cleanupReleaseConfig(runner, releaseConfigRemote, windows);
      await this.#cleanupRemote(runner, jobDir, state.id, windows);
      return settled;
    }
    const remote = await this.#readRemoteState(runner, state.id, windows);
    if (remote === null) {
      const message = "the member finished without writing a job state; see the log for its output";
      await appendLog(jobDir, message);
      const settled = await this.#update(jobDir, { status: "failed", phase: "failed", error: message, percent });
      await this.#cleanupReleaseConfig(runner, releaseConfigRemote, windows);
      await this.#cleanupRemote(runner, jobDir, state.id, windows);
      return settled;
    }
    if (remote.status !== "done") {
      const message = typeof remote.error === "string" && remote.error !== "" ? remote.error : `member build ended with status ${String(remote.status)}`;
      await appendLog(jobDir, `member job ${String(remote.status)}: ${message}`);
      const status = remote.status === "needs-fix" ? "needs-fix" : remote.status === "smoke-failed" ? "smoke-failed" : "failed";
      const settled = await this.#update(jobDir, {
        status,
        phase: remote.phase ?? "failed",
        error: status === "failed" ? message : null,
        percent,
        remoteJob: remote.id ?? null,
        remoteWorktree: remote.worktree ?? null,
        workOrder: remote.workOrder ?? null,
        mismatches: remote.mismatches ?? []
      });
      await this.#cleanupReleaseConfig(runner, releaseConfigRemote, windows);
      if (status !== "needs-fix") await this.#cleanupRemote(runner, jobDir, state.id, windows);
      return settled;
    }
    const directories = Array.isArray(remote.artifacts) ? remote.artifacts : [];
    const artifacts = [];
    let pulled = 0;
    if (directories.length > 0) await this.#update(jobDir, { phase: "fetch", percent: 96, currentTarget: null });
    for (const artifact of directories) {
      const archive = typeof artifact.archive === "string" ? artifact.archive : "";
      if (archive === "") continue;
      const local = await this.#pull(runner, archive, windows);
      const info = await stat9(local);
      const digest = await sha256File3(local);
      await writeSidecar(local, digest);
      artifacts.push({
        target: artifact.target,
        archive: local,
        remoteArchive: archive,
        bytes: info.size,
        sha256: digest,
        manifest: artifact.manifest ?? null,
        smoke: artifact.smoke ?? null
      });
      await appendLog(jobDir, `pulled ${path15.basename(local)} (${String(info.size)} bytes, sha256 ${digest.slice(0, 12)}\u2026)`);
      pulled += 1;
      await this.#update(jobDir, { phase: "fetch", percent: 96 + Math.round(3 * pulled / directories.length) });
    }
    const done = await this.#update(jobDir, {
      status: "done",
      phase: "done",
      percent: 100,
      currentTarget: null,
      artifacts,
      remoteJob: remote.id ?? null,
      version: remote.version ?? null,
      publish: remote.publish ?? null
    });
    await this.#cleanupReleaseConfig(runner, releaseConfigRemote, windows);
    await this.#cleanupRemote(runner, jobDir, state.id, windows);
    return done;
  }
  /**
   * Ship the release config to the build machine with the narrowest mode.
   *
   * `cat > file` would otherwise create a world-readable file under the
   * default umask. The file is created first with `umask 077`, then its mode
   * is forced again after the upload; the token never appears in the script or
   * in the log.
   * @param {SshRunner} runner ssh runner.
   * @param {object} config release config.
   * @param {string} remote remote path.
   * @param {boolean} windows whether the member runs Windows.
   * @returns {Promise<void>} completion.
   */
  async #uploadReleaseConfig(runner, config, remote, windows) {
    const dir = await mkdtemp6(path15.join(tmpdir4(), "dsh-mesh-release-config-"));
    const local = path15.join(dir, "release.json");
    await writeFile9(local, `${JSON.stringify(config, null, 2)}
`, { encoding: "utf8", mode: 384 });
    try {
      if (windows) {
        const dir2 = path15.win32.dirname(remote);
        await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), `cmd /c if not exist "${dir2}" mkdir "${dir2}"`]);
      } else {
        await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), `umask 077; : > '${remote.replace(/'/gu, `'\\''`)}'`]);
      }
      await runner.upload(local, remote);
      if (!windows) {
        await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), `chmod 600 '${remote.replace(/'/gu, `'\\''`)}'`]);
      }
    } finally {
      await rm10(dir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
  /**
   * Remove the release config from the build machine.
   * @param {SshRunner} runner ssh runner.
   * @param {string|null} remote remote path, or null.
   * @param {boolean} windows whether the member runs Windows.
   * @returns {Promise<void>} completion.
   */
  async #cleanupReleaseConfig(runner, remote, windows) {
    if (remote === null) return;
    const command = windows ? `cmd /c del /f /q "${remote}"` : `rm -f '${remote.replace(/'/gu, `'\\''`)}'`;
    await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), command]).catch((error) => {
      this.log(`could not remove the remote release config (${error instanceof Error ? error.message : String(error)})`);
    });
  }
  /**
   * Delete the member-side job directory once its outcome is settled.
   *
   * The gateway keeps the job state and mirrors the member's output into its
   * own build log, so the member only needs the directory while the build
   * runs. Removing it keeps the next full build from starting on a disk that
   * older jobs filled. Windows deletes through Node's fs.rmSync because
   * node_modules paths are longer than MAX_PATH and Remove-Item gives up on
   * them halfway.
   * @param {SshRunner} runner ssh runner.
   * @param {string} jobDir local job directory (the cleanup is logged there).
   * @param {string} jobId build job id (also the remote directory name).
   * @param {boolean} windows whether the member runs Windows.
   * @returns {Promise<void>} completion.
   */
  async #cleanupRemote(runner, jobDir, jobId, windows) {
    const localPath = `$HOME/.dsh/mesh/build/${jobId}`;
    const command = windows ? powershellCommand([
      "$ProgressPreference = 'SilentlyContinue'",
      `$out = Join-Path $env:USERPROFILE '.dsh\\mesh\\build\\${jobId}'`,
      "$node = Join-Path $env:USERPROFILE '.dsh\\dsh-mesh\\current\\runtime\\node\\node.exe'",
      "if (-not (Test-Path $node)) { $node = Join-Path $env:USERPROFILE '.dsh\\dsh-person-web\\runtime\\node\\node.exe' }",
      `if ((Test-Path $out) -and (Test-Path $node)) { & $node -e "const fs=require('fs');fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:5,retryDelay:200})" $out }`,
      "if (Test-Path $out) { Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue }"
    ].join("; ")) : `rm -rf "${localPath}"`;
    try {
      await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), command]);
      await appendLog(jobDir, `member build dir removed: ${jobId}`);
      this.log(`remote build dir removed: ${jobId}`);
    } catch (error) {
      this.log(`could not remove the remote build dir ${jobId} (the next build retries): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /**
   * Copy one remote archive into the packages directory.
   * @param {SshRunner} runner ssh runner.
   * @param {string} remote remote path.
   * @returns {Promise<string>} local path.
   */
  async #pull(runner, remote, windows = false) {
    const name = remote.split(/[\\/]/u).pop() ?? path15.basename(remote);
    const local = path15.join(this.packagesDir, name);
    const temporary = `${local}.part`;
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-P", String(runner.plan.port ?? 22)];
    if (runner.plan.identityFile) args.push("-i", runner.plan.identityFile);
    args.push(`${runner.target()}:${windows ? remote.replace(/\\/gu, "/") : remote}`, temporary);
    await runner.runProcess("scp", args);
    await rm10(local, { force: true });
    await rename7(temporary, local);
    return local;
  }
  /**
   * Read the member-side job state.
   * @param {SshRunner} runner ssh runner.
   * @param {string} jobId gateway job id (also the remote directory name).
   * @returns {Promise<object|null>} state.
   */
  async #readRemoteState(runner, jobId, windows = false) {
    try {
      const command = windows ? powershellCommand([
        "$ProgressPreference = 'SilentlyContinue'",
        `$out = Join-Path $env:USERPROFILE '.dsh\\mesh\\build\\${jobId}'`,
        "$file = Get-ChildItem -Path $out -Filter state.json -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1",
        // The file is UTF-8 with Chinese doc names; emitting its bytes as
        // base64 avoids the Windows console code page entirely.
        "if ($file) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName)) }"
      ].join("; ")) : `cat "${REMOTE_JOBS}/${jobId}"/*/state.json`;
      const { stdout } = await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), command]);
      const parsed = windows ? decodeWindowsState(stdout) : JSON.parse(stdout);
      if (parsed === null || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  }
  /**
   * Serialize one state write behind the ones already queued.
   * @param {string} jobDir job directory.
   * @param {object} patch fields.
   * @returns {Promise<object>} the new state.
   */
  #update(jobDir, patch) {
    const next = this.writes.then(() => updateState(jobDir, patch));
    this.writes = next.catch(() => {
    });
    return next;
  }
};
async function writeSidecar(file, digest) {
  await writeFile9(`${file}.sha256`, `${digest}  ${path15.basename(file)}
`, "utf8");
}

// code/shared/cluster.mjs
import { createHash as createHash5, createHmac, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
function deriveClusterSecret(password) {
  if (typeof password !== "string" || password === "") return "";
  return createHash5("sha256").update("dsh-mesh/cluster/v1\0").update(password, "utf8").digest("hex");
}
var CLUSTER_HEADER = "x-dsh-cluster";
var VERSION = "v1";
function signClusterRequest(secret, request) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("cluster secret is not configured");
  }
  const timestamp = request.timestamp ?? Date.now();
  const nonce = request.nonce ?? randomBytes2(16).toString("hex");
  const payload = payloadOf(request.method, request.path, timestamp, nonce);
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${VERSION}.${String(timestamp)}.${nonce}.${signature}`;
}
function payloadOf(method, path25, timestamp, nonce) {
  return [VERSION, String(method).toUpperCase(), path25, String(timestamp), nonce].join("\n");
}

// code/build/repack.mjs
import { execFile } from "node:child_process";
import { createHash as createHash6 } from "node:crypto";
import { cp as cp2, mkdir as mkdir10, mkdtemp as mkdtemp7, readFile as readFile12, readdir as readdir6, rm as rm11, stat as stat10, writeFile as writeFile10 } from "node:fs/promises";
import { createReadStream as createReadStream5, existsSync as existsSync9 } from "node:fs";
import path16 from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
var CODE_SCRIPTS = ["install.sh", "start.sh", "stop.sh", "status.sh", "doctor.sh", "install.ps1", "start.ps1", "stop.ps1", "start.cmd", "stop.cmd", "start-stack.ps1"];
var ROOT_SCRIPTS = ["start-interop.sh", "install-interop-service.sh", "uninstall-interop-service.sh"];
var PLUGIN_FILES = ["index.js", "client.js", "cordis.patch.yml", "package.json"];
var PLUGIN_DIRS = ["locale", "build", "code/build", "code/shared", "code/deploy"];
var CODE_DIRS = ["windows-service", "interop-service", "wireguard", "dsh-service", "deploy", "shared"];
async function clear(target) {
  await rm11(target, { recursive: true, force: true });
}
async function replaceDirectory(from, to) {
  if (!existsSync9(from)) return;
  await clear(to);
  await cp2(from, to, { recursive: true });
}
async function replaceFile(from, to) {
  if (!existsSync9(from)) return;
  await clear(to);
  await cp2(from, to);
}
async function countFiles(dir) {
  let total = 0;
  for (const entry of await readdir6(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(path16.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}
async function repackDirectory(packageDir, repositoryRoot) {
  const manifestFile = path16.join(packageDir, "manifest.json");
  if (!existsSync9(manifestFile)) throw new Error(`${packageDir} is not an extracted package (no manifest.json)`);
  await replaceDirectory(path16.join(repositoryRoot, "code", "gate"), path16.join(packageDir, "gate"));
  await replaceDirectory(path16.join(repositoryRoot, "code", "shared"), path16.join(packageDir, "shared"));
  await replaceDirectory(path16.join(repositoryRoot, "code", "config"), path16.join(packageDir, "config"));
  for (const name of CODE_DIRS) {
    await replaceDirectory(path16.join(repositoryRoot, "code", name), path16.join(packageDir, "code", name));
  }
  await replaceDirectory(path16.join(repositoryRoot, "docs"), path16.join(packageDir, "docs"));
  for (const name of CODE_SCRIPTS) {
    await replaceFile(path16.join(repositoryRoot, "code", name), path16.join(packageDir, name));
  }
  for (const name of ROOT_SCRIPTS) {
    await replaceFile(path16.join(repositoryRoot, name), path16.join(packageDir, name));
  }
  for (const name of PLUGIN_FILES) {
    await replaceFile(path16.join(repositoryRoot, name), path16.join(packageDir, "plugins", "dsh-mesh", name));
  }
  for (const name of PLUGIN_DIRS) {
    await replaceDirectory(path16.join(repositoryRoot, name), path16.join(packageDir, "plugins", "dsh-mesh", name));
  }
  const manifest = JSON.parse(await readFile12(manifestFile, "utf8"));
  const features = new Set(Array.isArray(manifest.features) ? manifest.features : []);
  features.add("embedded-interop");
  manifest.features = [...features];
  const staticAssets = await collectStaticAssets(path16.join(packageDir, "gate"));
  manifest.staticAssets = staticAssets;
  manifest.builtAt = (/* @__PURE__ */ new Date()).toISOString();
  manifest.repackedFrom = "code/build/repack.mjs";
  manifest.files = await countFiles(packageDir);
  await writeFile10(manifestFile, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
  const clientBytes = (await stat10(path16.join(packageDir, "plugins", "dsh-mesh", "client.js"))).size;
  return { packageDir, version: manifest.version, target: manifest.target, files: manifest.files, clientBytes };
}
async function sha256File4(file) {
  const hash = createHash6("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream5(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}
function archiveRootName(file) {
  return path16.basename(file).replace(/\.(tar\.gz|tgz|zip)$/u, "");
}
async function extractArchive(file, directory) {
  await mkdir10(directory, { recursive: true });
  if (file.endsWith(".zip")) {
    try {
      await run("unzip", ["-q", file, "-d", directory]);
    } catch {
      await run("tar", ["-xf", file, "-C", directory]);
    }
  } else {
    await run("tar", ["-xzf", file, "-C", directory]);
  }
  const root = path16.join(directory, archiveRootName(file));
  if (!existsSync9(path16.join(root, "manifest.json"))) {
    throw new Error(`archive ${path16.basename(file)} has no ${archiveRootName(file)}/manifest.json`);
  }
  return root;
}
async function compressDirectory(parent, name, file) {
  await clear(file);
  if (file.endsWith(".zip")) {
    try {
      await run("zip", ["-qr", "-X", file, name], { cwd: parent });
    } catch {
      await run("tar", ["-a", "-cf", file, name], { cwd: parent });
    }
  } else {
    await run("tar", ["-czf", file, name], { cwd: parent });
  }
}
async function repackArchive(file, { repositoryRoot, log = () => {
} }) {
  const work = await mkdtemp7(path16.join(path16.dirname(file), ".repack-"));
  try {
    log(`extracting ${path16.basename(file)}`);
    const packageDir = await extractArchive(file, work);
    const summary = await repackDirectory(packageDir, repositoryRoot);
    log(`replaced gateway, scripts and plugin files (${String(summary.files)} files in the package)`);
    const parent = path16.dirname(packageDir);
    const name = path16.basename(packageDir);
    await compressDirectory(parent, name, file);
    const bytes = (await stat10(file)).size;
    const sha256 = await sha256File4(file);
    await writeFile10(`${file}.sha256`, `${sha256}  ${path16.basename(file)}

`, "utf8");
    log(`wrote ${path16.basename(file)} (${String(bytes)} bytes)`);
    return { package: file, version: summary.version, target: summary.target, bytes, sha256, files: summary.files };
  } finally {
    await rm11(work, { recursive: true, force: true });
  }
}

// code/shared/system-info.mjs
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync10, readFileSync as readFileSync3, statfsSync } from "node:fs";
import os7 from "node:os";
import { promisify as promisify2 } from "node:util";
var execFileAsync = promisify2(execFile2);
var PSEUDO_FILESYSTEMS = /* @__PURE__ */ new Set([
  "proc",
  "sysfs",
  "devtmpfs",
  "devpts",
  "tmpfs",
  "cgroup",
  "cgroup2",
  "pstore",
  "securityfs",
  "debugfs",
  "tracefs",
  "configfs",
  "fusectl",
  "mqueue",
  "hugetlbfs",
  "rpc_pipefs",
  "autofs",
  "binfmt_misc",
  "nsfs",
  "squashfs",
  "ramfs"
]);
function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function safeNumber(value) {
  return Number.isFinite(value) ? value : 0;
}
function decodeMount(text) {
  return text.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
function diskEntry(mount, fs = "", type = "") {
  try {
    const stats = statfsSync(mount);
    const blockSize = safeNumber(stats.bsize);
    const total = blockSize * safeNumber(stats.blocks);
    const free = blockSize * safeNumber(stats.bfree);
    const available = blockSize * safeNumber(stats.bavail);
    if (total <= 0) return null;
    return {
      mount,
      fs,
      type,
      totalBytes: total,
      freeBytes: free,
      availableBytes: available,
      usedBytes: Math.max(0, total - free),
      usedPercent: total === 0 ? 0 : round((total - free) / total * 100, 1)
    };
  } catch {
    return null;
  }
}
async function linuxDisks() {
  const mounts = [];
  try {
    const text = readFileSync3("/proc/mounts", "utf8");
    for (const raw of text.split("\n")) {
      if (raw.trim() === "") continue;
      const [device, mountRaw, type] = raw.split(" ");
      if (device === void 0 || mountRaw === void 0 || type === void 0) continue;
      if (PSEUDO_FILESYSTEMS.has(type)) continue;
      const mount = decodeMount(mountRaw);
      if (!mount.startsWith("/")) continue;
      if (mounts.some((item) => item.mount === mount)) continue;
      mounts.push({ mount, type });
    }
  } catch {
  }
  if (!mounts.some((item) => item.mount === "/")) mounts.unshift({ mount: "/", type: "" });
  return mounts.map((item) => diskEntry(item.mount, "", item.type)).filter(Boolean);
}
function windowsDisks() {
  const result = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (!existsSync10(root)) continue;
    const entry = diskEntry(root, "", "");
    if (entry !== null) result.push(entry);
  }
  return result;
}
async function posixDisks() {
  try {
    const { stdout } = await execFileAsync("df", ["-P", "-k"], { timeout: 5e3 });
    const result = [];
    const lines = stdout.trim().split("\n").slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const mount = parts[5];
      if (!mount.startsWith("/")) continue;
      const entry = diskEntry(mount, parts[0], "");
      if (entry !== null) result.push(entry);
    }
    return result;
  } catch {
    return [];
  }
}
async function collectDisks() {
  if (process.platform === "win32") return windowsDisks();
  if (process.platform === "linux") {
    const linux = await linuxDisks();
    if (linux.length > 0) return linux;
  }
  return posixDisks();
}
function cpuSnapshot() {
  return os7.cpus().map((cpu) => ({ ...cpu.times }));
}
function cpuUsage(before, after) {
  let idleDelta = 0;
  let userDelta = 0;
  let systemDelta = 0;
  let totalDelta = 0;
  for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
    const a = before[index];
    const b = after[index];
    const user = b.user - a.user + (b.nice - a.nice);
    const system = b.sys - a.sys + (b.irq - a.irq);
    const idle = b.idle - a.idle;
    userDelta += user;
    systemDelta += system;
    idleDelta += idle;
    totalDelta += user + system + idle;
  }
  if (totalDelta <= 0) return { usagePercent: 0, idlePercent: 100, userPercent: 0, systemPercent: 0 };
  const idlePercent = idleDelta / totalDelta * 100;
  return {
    usagePercent: round(100 - idlePercent, 1),
    idlePercent: round(idlePercent, 1),
    userPercent: round(userDelta / totalDelta * 100, 1),
    systemPercent: round(systemDelta / totalDelta * 100, 1)
  };
}
function networkInfo() {
  const result = [];
  for (const [name, addresses] of Object.entries(os7.networkInterfaces())) {
    for (const address of addresses ?? []) {
      result.push({
        name,
        address: address.address,
        family: address.family,
        internal: address.internal,
        mac: address.mac,
        cidr: address.cidr ?? null
      });
    }
  }
  return result;
}
function quickSystemInfo(options = {}) {
  const cpus = os7.cpus();
  const total = os7.totalmem();
  const free = os7.freemem();
  const used = Math.max(0, total - free);
  let cpuTotal = 0;
  let cpuIdle = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    cpuTotal += times.user + times.nice + times.sys + times.irq + times.idle;
    cpuIdle += times.idle;
  }
  const cpuUsage2 = cpuTotal === 0 ? 0 : round((1 - cpuIdle / cpuTotal) * 100, 1);
  const root = process.platform === "win32" ? `${(process.env.SystemDrive ?? "C:").replace(/\\$/u, "")}\\` : "/";
  const disks = [];
  try {
    const stats = statfsSync(root);
    const blockSize = safeNumber(stats.bsize);
    const totalBytes = blockSize * safeNumber(stats.blocks);
    const freeBytes = blockSize * safeNumber(stats.bfree);
    if (totalBytes > 0) {
      disks.push({
        mount: root,
        totalBytes,
        freeBytes,
        availableBytes: blockSize * safeNumber(stats.bavail),
        usedBytes: Math.max(0, totalBytes - freeBytes),
        usedPercent: round((totalBytes - freeBytes) / totalBytes * 100, 1)
      });
    }
  } catch {
  }
  return {
    sampledAt: (/* @__PURE__ */ new Date()).toISOString(),
    hostname: os7.hostname(),
    platform: process.platform,
    arch: process.arch,
    home: options.home ?? os7.homedir(),
    appRoot: options.appRoot ?? process.env.DSH_PACKAGE_ROOT ?? process.cwd(),
    user: os7.userInfo().username,
    cpu: { model: cpus[0]?.model ?? "unknown", cores: cpus.length, usagePercent: cpuUsage2 },
    memory: {
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      usedPercent: total === 0 ? 0 : round(used / total * 100, 1)
    },
    disks
  };
}
async function collectSystemInfo(options = {}) {
  const requested = Number.isSafeInteger(options.sampleMs) ? options.sampleMs : 200;
  const sampleMs = Math.max(50, Math.min(requested, 1e3));
  const before = cpuSnapshot();
  const disksPromise = collectDisks();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const after = cpuSnapshot();
  const cpuTimes = cpuUsage(before, after);
  const cpus = os7.cpus();
  const totalMemory = os7.totalmem();
  const freeMemory = os7.freemem();
  const memoryUsed = Math.max(0, totalMemory - freeMemory);
  const load = os7.loadavg();
  return {
    sampledAt: (/* @__PURE__ */ new Date()).toISOString(),
    hostname: os7.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os7.release(),
    home: options.home ?? os7.homedir(),
    appRoot: options.appRoot ?? process.env.DSH_PACKAGE_ROOT ?? process.cwd(),
    user: os7.userInfo().username,
    uptimeSeconds: Math.floor(os7.uptime()),
    node: process.version,
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      cores: cpus.length,
      speedMHz: cpus[0]?.speed ?? 0,
      ...cpuTimes,
      loadAverage: load.map((value) => round(value, 2)),
      sampleMs
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: memoryUsed,
      usedPercent: totalMemory === 0 ? 0 : round(memoryUsed / totalMemory * 100, 1)
    },
    disks: await disksPromise,
    network: networkInfo(),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: process.memoryUsage()
    }
  };
}

// src/lib/schedule.mjs
import path17 from "node:path";
var DEFAULT_BUILD_SCHEDULE = Object.freeze({ enabled: true, time: "04:00" });
var DEFAULT_UPGRADE_SCHEDULE = Object.freeze({ enabled: true, time: "06:00" });
function parseClock(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}
function formatClock(clock) {
  const hour = clock?.hour;
  const minute = clock?.minute;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
function normalizeEntry(value, fallback) {
  const source = value !== null && typeof value === "object" ? value : {};
  const parsed = parseClock(source.time);
  const time = parsed === null ? fallback.time : formatClock(parsed);
  return { enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled, time };
}
function normalizeBuildSchedule(value) {
  return normalizeEntry(value, DEFAULT_BUILD_SCHEDULE);
}
function normalizeUpgradeSchedule(value) {
  return normalizeEntry(value, DEFAULT_UPGRADE_SCHEDULE);
}
function normalizeSchedules(value) {
  const source = value !== null && typeof value === "object" ? value : {};
  const upgrades = {};
  const raw = source.upgrades !== null && typeof source.upgrades === "object" ? source.upgrades : {};
  for (const [memberId, entry] of Object.entries(raw)) {
    if (typeof memberId === "string" && memberId !== "" && entry !== null && typeof entry === "object") {
      upgrades[memberId] = normalizeUpgradeSchedule(entry);
    }
  }
  return {
    build: normalizeBuildSchedule(source.build),
    upgrade: normalizeUpgradeSchedule(source.upgrade),
    upgrades
  };
}
function upgradeEntryFor(schedules, memberId) {
  const entry = schedules?.upgrades?.[memberId];
  return entry !== null && typeof entry === "object" ? entry : schedules?.upgrade ?? DEFAULT_UPGRADE_SCHEDULE;
}
function nextRunAt(at, time) {
  const clock = parseClock(time) ?? parseClock(DEFAULT_BUILD_SCHEDULE.time);
  const next = new Date(at.getTime());
  next.setHours(clock.hour, clock.minute, 0, 0);
  if (next.getTime() <= at.getTime()) next.setDate(next.getDate() + 1);
  return next;
}
function packageInfo(name) {
  if (typeof name !== "string") return null;
  const match = /^dsh-mesh-(.+)-(\d{8}[A-Z]+)-(linux|win(?:dows)?)-(?:x64|arm64)\.(?:tar\.gz|tgz|zip)$/u.exec(name);
  if (match === null) return null;
  return {
    version: match[1],
    buildStamp: match[2],
    os: match[3].startsWith("win") ? "windows" : "linux"
  };
}
function stampRank(stamp) {
  const match = /^(\d{8})([A-Z]+)$/u.exec(String(stamp ?? ""));
  if (match === null) return null;
  let letter = 0;
  for (const char of match[2]) letter = letter * 26 + (char.charCodeAt(0) - 64);
  return { date: Number(match[1]), letter };
}
function compareBuildStamps(left, right) {
  const a = stampRank(left);
  const b = stampRank(right);
  if (a === null || b === null) return String(left ?? "").localeCompare(String(right ?? ""));
  if (a.date !== b.date) return a.date - b.date;
  return a.letter - b.letter;
}
function latestPackagesByOs(packages) {
  const latest = {};
  for (const item of Array.isArray(packages) ? packages : []) {
    const parsed = packageInfo(item.name);
    const os9 = parsed?.os ?? (item.target === "windows" ? "windows" : item.target === "linux" ? "linux" : null);
    if (os9 === null) continue;
    const current = latest[os9];
    if (current === void 0) {
      latest[os9] = item;
      continue;
    }
    const currentInfo = packageInfo(current.name);
    if (parsed !== null && currentInfo !== null) {
      if (compareBuildStamps(parsed.buildStamp, currentInfo.buildStamp) > 0) latest[os9] = item;
    } else if (String(item.mtime ?? "") > String(current.mtime ?? "")) {
      latest[os9] = item;
    }
  }
  return latest;
}
function memberDeployment(member) {
  const direct = member?.deployment;
  if (direct !== null && typeof direct === "object") return direct;
  const nested = member?.gate?.deployment;
  return nested !== null && typeof nested === "object" ? nested : null;
}
function shouldUpgrade(deployment, candidate) {
  const parsed = packageInfo(candidate?.name);
  if (parsed === null) return { needed: true, reason: "\u90E8\u7F72\u5305\u540D\u79F0\u65E0\u6CD5\u89E3\u6790\u7248\u672C\uFF0C\u6309\u9700\u8981\u5347\u7EA7\u5904\u7406" };
  const currentStamp = typeof deployment?.buildStamp === "string" ? deployment.buildStamp : "";
  if (currentStamp !== "") {
    const order = compareBuildStamps(parsed.buildStamp, currentStamp);
    if (order === 0) return { needed: false, reason: "\u5DF2\u7ECF\u662F\u8FD9\u4E2A\u90E8\u7F72\u5305" };
    if (order < 0) return { needed: false, reason: "\u6700\u65B0\u5305\u7684\u6784\u5EFA\u53F7\u6BD4\u5F53\u524D\u90E8\u7F72\u65E7" };
    return { needed: true, reason: `${currentStamp} \u2192 ${parsed.buildStamp}` };
  }
  const currentVersion = typeof deployment?.version === "string" ? deployment.version : "";
  if (currentVersion !== "" && currentVersion === parsed.version) {
    return { needed: false, reason: `\u5DF2\u7ECF\u662F ${parsed.version}` };
  }
  return { needed: true, reason: `\u5347\u7EA7\u5230 ${parsed.buildStamp}` };
}
function memberOs(member) {
  const platform = String(member?.system?.platform ?? member?.gate?.system?.platform ?? "").toLowerCase();
  if (platform.startsWith("win")) return "windows";
  if (platform.startsWith("linux")) return "linux";
  const target = String(memberDeployment(member)?.target?.os ?? "").toLowerCase();
  return target.startsWith("win") ? "windows" : "linux";
}
function planUpgrades(members, packages) {
  const latest = latestPackagesByOs(packages);
  const upgrades = [];
  const skipped2 = [];
  const rows = (Array.isArray(members) ? members : []).filter(Boolean);
  const ordered = [
    ...rows.filter((member) => member.id !== "local" && member.kind !== "self"),
    ...rows.filter((member) => member.id === "local" || member.kind === "self")
  ];
  for (const member of ordered) {
    const deployment = memberDeployment(member);
    if (deployment === null) {
      skipped2.push({ member, reason: "\u8BFB\u4E0D\u5230\u5F53\u524D\u90E8\u7F72" });
      continue;
    }
    if (member.online === false) {
      skipped2.push({ member, reason: "\u79BB\u7EBF" });
      continue;
    }
    const os9 = memberOs(member);
    const candidate = latest[os9];
    if (candidate === void 0) {
      skipped2.push({ member, reason: `\u6CA1\u6709 ${os9 === "windows" ? "Windows" : "Linux"} \u90E8\u7F72\u5305` });
      continue;
    }
    const decision = shouldUpgrade(deployment, candidate);
    if (decision.needed) upgrades.push({ member, package: candidate });
    else skipped2.push({ member, reason: decision.reason });
  }
  return { upgrades, skipped: skipped2 };
}
function buildUpdateReasons(input) {
  const latest = input.latestManifest;
  const current = input.current;
  if (latest === null || typeof latest !== "object") return ["\u8FD8\u6CA1\u6709\u5E26\u7248\u672C\u4FE1\u606F\u7684\u7F16\u8BD1\u4EFB\u52A1"];
  const reasons = [];
  if (latest.source !== current.source || latest.ref !== current.ref) {
    reasons.push("\u6E90\u7801\u6216\u5F15\u7528\u53D8\u4E86");
  }
  if (latest.sourceEtag === void 0 || latest.sourceEtag === null || current.sourceEtag === null) {
    reasons.push("\u65E0\u6CD5\u786E\u8BA4 DSH \u6E90\u7801\u7248\u672C");
  } else if (latest.sourceEtag !== current.sourceEtag) {
    reasons.push("DSH \u6E90\u7801\u6709\u66F4\u65B0");
  }
  const plugin = latest.plugin;
  if (plugin === null || typeof plugin !== "object" || typeof plugin.fingerprint !== "string" || current.pluginFingerprint === null) {
    reasons.push("\u65E0\u6CD5\u786E\u8BA4 dsh-mesh \u7248\u672C");
  } else if (plugin.fingerprint !== current.pluginFingerprint) {
    reasons.push("dsh-mesh \u6709\u66F4\u65B0");
  }
  const latestPlugins = Array.isArray(latest.extraPlugins) ? latest.extraPlugins : [];
  for (const entry of current.extraPlugins) {
    const previous = latestPlugins.find((item) => item?.name === entry.name);
    const previousEtag = typeof previous?.archiveEtag === "string" ? previous.archiveEtag : "";
    if (previousEtag === "" || entry.etag === null) reasons.push(`${entry.name} \u6709\u66F4\u65B0`);
    else if (previousEtag !== entry.etag) reasons.push(`${entry.name} \u6709\u66F4\u65B0`);
  }
  return reasons;
}
function scheduleFile(dataDir) {
  return path17.join(dataDir, "schedule.json");
}

// src/lib/build-defaults.mjs
var DEFAULT_BUILD_TARGETS = Object.freeze(["linux-x64", "win-x64"]);
function memberPlatform(member) {
  return String(member?.system?.platform ?? "").trim().toLowerCase();
}
function canBuildOn(member) {
  if (member === null || typeof member !== "object") return false;
  if (member.online === false) return false;
  const platform = memberPlatform(member);
  return platform === "" || platform.startsWith("linux") || platform.startsWith("win");
}
function canProxyThrough(member) {
  if (member === null || typeof member !== "object") return false;
  if (member.id === "local" || member.kind === "self") return false;
  if (member.online === false) return false;
  const platform = memberPlatform(member);
  return platform === "" || platform.startsWith("linux");
}
function memberCores(member) {
  const value = Number(member?.system?.cpu?.cores);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function memberMemoryBytes(member) {
  const value = Number(member?.system?.memory?.totalBytes);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function isForeignMember(member) {
  const code = typeof member?.countryCode === "string" ? member.countryCode.trim().toUpperCase() : "";
  if (/^[A-Z]{2}$/u.test(code)) return code !== "CN";
  const tag = typeof member?.tag === "string" ? member.tag : "";
  return /(?:国外|境外|海外|foreign|overseas|可访问外网|外网)/iu.test(tag);
}
function compareBuildCapacity(left, right) {
  const cores = memberCores(right) - memberCores(left);
  if (cores !== 0) return cores;
  const memory = memberMemoryBytes(right) - memberMemoryBytes(left);
  if (memory !== 0) return Math.sign(memory);
  const leftUsage = Number(left?.system?.cpu?.usagePercent);
  const rightUsage = Number(right?.system?.cpu?.usagePercent);
  const usageLeft = Number.isFinite(leftUsage) ? leftUsage : Number.POSITIVE_INFINITY;
  const usageRight = Number.isFinite(rightUsage) ? rightUsage : Number.POSITIVE_INFINITY;
  if (usageLeft !== usageRight) return usageLeft - usageRight;
  if (left?.id === "local" && right?.id !== "local") return -1;
  if (right?.id === "local" && left?.id !== "local") return 1;
  return String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
}
function pickBuildMember(members) {
  const candidates = Array.isArray(members) ? members.filter(canBuildOn) : [];
  if (candidates.length === 0) return "local";
  return [...candidates].sort(compareBuildCapacity)[0]?.id ?? "local";
}
function pickProxyMember(members) {
  const candidates = Array.isArray(members) ? members.filter((member) => canProxyThrough(member) && isForeignMember(member)) : [];
  if (candidates.length === 0) return null;
  const latency = (member) => Number.isFinite(Number(member?.latencyMs)) ? Number(member.latencyMs) : Number.POSITIVE_INFINITY;
  return [...candidates].sort((left, right) => {
    const reachable = (right.dsh === false ? 1 : 0) - (left.dsh === false ? 1 : 0);
    if (reachable !== 0) return reachable;
    const rtt = latency(left) - latency(right);
    if (rtt !== 0) return rtt;
    return compareBuildCapacity(left, right);
  })[0]?.id ?? null;
}

// src/lib/service.mjs
var HERE2 = path18.dirname(fileURLToPath2(import.meta.url));
var PROBE_GRACE_MS = 10 * 6e4;
var PROBE_TIMEOUT_MS = 4500;
var PROBE_RETRY_MS = 4500;
var PROBE_CACHE_TTL_MS = 7 * 24 * 60 * 6e4;
function findRepositoryRoot(start) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync11(path18.join(current, "build", "recipes.json")) && existsSync11(path18.join(current, "code", "build"))) {
      return current;
    }
    const parent = path18.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path18.resolve(start, "..", "..");
}
var REPOSITORY_ROOT = findRepositoryRoot(HERE2);
function packageVersion() {
  try {
    const parsed = JSON.parse(readFileSync4(path18.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function assertTestUpgradeTarget(target, options = {}) {
  if (target === null || target === void 0) {
    throw new Error("\u6D4B\u8BD5\u5347\u7EA7\u9700\u8981\u4E00\u4E2A\u6210\u5458\uFF1A\u8BF7\u4ECE\u6210\u5458\u5217\u8868\u91CC\u9009\u4E00\u4E2A\u5DF2\u5B89\u88C5 DSH \u7684 Linux \u6210\u5458");
  }
  if (target.kind === "self" || target.id === "local") {
    throw new Error("\u6D4B\u8BD5\u5347\u7EA7\u8981\u5728\u522B\u7684\u6210\u5458\u4E0A\u8DD1\uFF1B\u672C\u673A\u5347\u7EA7\u8BF7\u76F4\u63A5\u7528\u300C\u5347\u7EA7\u300D");
  }
  const memberOs2 = /win/iu.test(target.system?.platform ?? "") ? "windows" : "linux";
  if (options.packageOs !== void 0 && options.packageOs !== memberOs2) {
    throw new Error(`\u9009\u7684\u662F ${options.packageOs === "windows" ? "Windows" : "Linux"} \u90E8\u7F72\u5305\uFF0C\u4F46\u6210\u5458 ${String(target.name ?? target.id)} \u662F ${memberOs2}\uFF1B\u6362\u4E00\u4E2A\u5339\u914D\u7684\u5305`);
  }
  if (target.dsh !== true) {
    throw new Error(`\u6210\u5458 ${String(target.name ?? target.id)} \u8FD8\u6CA1\u6709\u5B89\u88C5 DSH\uFF0C\u6CA1\u6709\u53EF\u5347\u7EA7\u7684\u5B89\u88C5\uFF1B\u8BF7\u5148\u7528\u300C\u90E8\u7F72\u300D`);
  }
  return target;
}
var MeshService = class {
  /**
   * @param {{dataDir: string, config?: object, log?: (line: string) => void, spawnRunner?: Function, geoLookup?: object}} options service input.
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.config = options.config ?? {};
    this.logLine = options.log ?? (() => {
    });
    this.jobRoot = path18.join(this.dataDir, "build");
    this.cacheDir = path18.join(this.dataDir, "cache");
    this.version = packageVersion();
    this.repositoryRoot = REPOSITORY_ROOT;
    this.recipesPath = path18.join(REPOSITORY_ROOT, "build", "recipes.json");
    this.overlayRoot = path18.join(REPOSITORY_ROOT, "build", "overlays");
    this.home = path18.dirname(this.dataDir);
    this.deployRoot = path18.join(this.dataDir, "deploy");
    this.memberTagsFile = path18.join(this.dataDir, "member-tags.json");
    this.packagesDir = path18.join(os8.homedir(), ".dsh", "packages");
    this.releaseConfigFile = path18.join(this.dataDir, "release.json");
    const geoConfig = this.config.geo === false ? { enabled: false } : this.config.geo !== null && typeof this.config.geo === "object" ? this.config.geo : {};
    this.geo = options.geoLookup ?? new GeoLookup({
      enabled: geoConfig.enabled !== false,
      cacheFile: path18.join(this.dataDir, "geo-cache.json"),
      provider: typeof geoConfig.provider === "string" && geoConfig.provider !== "" ? geoConfig.provider : void 0,
      timeoutMs: typeof geoConfig.timeoutMs === "number" ? geoConfig.timeoutMs : void 0,
      fetchImpl: typeof geoConfig.fetchImpl === "function" ? geoConfig.fetchImpl : void 0,
      log: (line) => this.logLine(`geo: ${line}`)
    });
    this.deploy = new DeployManager({
      repositoryRoot: REPOSITORY_ROOT,
      dataDir: this.deployRoot,
      log: (line) => this.logLine(`deploy: ${line}`)
    });
    this.spawnRunner = options.spawnRunner ?? ((dir, id) => this.#spawnRunner(dir, id));
    this.running = /* @__PURE__ */ new Map();
    this.egress = new EgressProxy({ log: (line) => this.logLine(line) });
    this.remoteBuilder = new RemoteBuilder({ packagesDir: this.packagesDir, log: (line) => this.logLine(line) });
    this.systemCache = null;
    this.probes = /* @__PURE__ */ new Map();
    this.probeCacheFile = path18.join(this.dataDir, "probe-cache.json");
    this.probeCacheLoaded = false;
    this.fetchImpl = options.fetchImpl;
  }
  /**
   * Seed the probe map from the last run.
   *
   * The map lives in memory, so a panel reload used to forget that a peer was
   * installed and show 未部署 (with a tempting 部署 button) until the slow peer
   * answered again. The file keeps that knowledge across restarts; entries age
   * out after a week so an uninstalled member is eventually re-detected.
   */
  async #loadProbes() {
    if (this.probeCacheLoaded) return;
    this.probeCacheLoaded = true;
    try {
      const parsed = JSON.parse(await readFile13(this.probeCacheFile, "utf8"));
      if (parsed === null || typeof parsed !== "object") return;
      const now = Date.now();
      for (const [ip, entry] of Object.entries(parsed)) {
        if (this.probes.has(ip) || entry === null || typeof entry !== "object") continue;
        const at = Number(entry.at);
        if (!Number.isFinite(at)) continue;
        const expiresAt = at + PROBE_CACHE_TTL_MS;
        if (expiresAt <= now) continue;
        this.probes.set(ip, {
          port: Number.isInteger(entry.port) ? entry.port : null,
          gate: entry.gate ?? null,
          system: entry.system ?? null,
          latencyMs: Number(entry.latencyMs) || 0,
          at,
          expiresAt
        });
      }
    } catch {
    }
  }
  /** Persist the probe map; a failed write is not worth reporting. */
  async #saveProbes() {
    try {
      await mkdir11(path18.dirname(this.probeCacheFile), { recursive: true });
      await writeFile11(this.probeCacheFile, JSON.stringify(Object.fromEntries(this.probes)), "utf8");
    } catch {
    }
  }
  /** Cached local host inventory for the member table. */
  async systemInfo() {
    if (this.systemCache !== null && this.systemCache.expiresAt > Date.now()) return this.systemCache.value;
    const value = quickSystemInfo();
    this.systemCache = { value, expiresAt: Date.now() + 3e4 };
    return value;
  }
  /** No child process is owned directly; jobs own their own. */
  async dispose() {
    this.egress.closeAll();
    await this.deploy.dispose();
  }
  /**
   * Local host and WireGuard facts.
   * @returns {Promise<object>} status.
   */
  async status() {
    const stateFile = path18.join(this.home, "wireguard", "state.json");
    const { state, error } = await readWireGuardState({ file: stateFile });
    const identity = state === null ? null : wireGuardIdentity(state);
    return {
      ok: true,
      host: {
        hostname: os8.hostname(),
        platform: process.platform,
        arch: process.arch,
        version: this.version,
        dataDir: this.dataDir,
        repositoryRoot: this.repositoryRoot
      },
      wireguard: identity === null ? { available: false, error, stateFile } : {
        available: true,
        stateFile,
        role: identity.role,
        connected: identity.connected,
        vpnCidr: identity.vpnCidr,
        serverIp: identity.serverIp,
        serverUrl: identity.serverUrl,
        selfIp: identity.selfIp,
        selfName: identity.selfName,
        lastHandshakeAt: identity.lastHandshakeAt,
        warnings: identity.warnings
      },
      gate: { url: typeof this.config.gateUrl === "string" ? this.config.gateUrl : "" },
      build: {
        source: typeof this.config.build?.source === "string" ? this.config.build.source : "",
        ref: typeof this.config.build?.ref === "string" ? this.config.build.ref : "master",
        targets: Array.isArray(this.config.build?.targets) ? this.config.build.targets : ["linux-x64", "win-x64"],
        jobRoot: this.jobRoot
      },
      deploy: { jobRoot: this.deployRoot }
    };
  }
  /**
   * Discover members from this host. The gate has its own copy of this logic;
   * this one keeps the panel useful when DSH is opened directly.
   * @returns {Promise<object>} discovery snapshot.
   */
  /**
   * Ask a Windows member to move its stack into the interactive session.
   *
   * The request travels as a cluster call, the same signed channel a member
   * switch uses, so no new secret is introduced. The member's gate writes the
   * supervisor command file and answers with the supervisor's status.
   * @param {string} target member id, name or address.
   * @returns {Promise<{ok: boolean, member: object, status: object|null}>} result.
   */
  async promoteSession(target) {
    const wanted = String(target ?? "").trim();
    if (wanted === "") throw new Error("member is required");
    const snapshot = await this.members();
    const all = [snapshot.local, ...Array.isArray(snapshot.members) ? snapshot.members : []].filter(Boolean);
    const member = all.find((candidate) => candidate.id === wanted || candidate.name === wanted || candidate.ip === wanted);
    if (member === void 0) throw new Error(`member not found: ${wanted}`);
    const password = process.env.DSH_GATE_PASSWORD ?? "";
    if (password === "") throw new Error("DSH_GATE_PASSWORD is not set; cannot sign the cluster request");
    let host = String(member.ip ?? "");
    if (host === "") throw new Error(`member ${member.id} has no VPN address`);
    if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
    const path25 = "/__gate/cluster/__gate/session/promote";
    const response = await fetch(`http://${host}${path25}`, {
      method: "POST",
      headers: { [CLUSTER_HEADER]: signClusterRequest(deriveClusterSecret(password), { method: "POST", path: path25 }) }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`member ${member.name} refused the request: HTTP ${String(response.status)} ${text.slice(0, 120)}`);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
    }
    return { ok: true, member: { id: member.id, name: member.name, ip: member.ip }, status: parsed?.status ?? null };
  }
  /**
   * Conversations controlled by every member's interop service, grouped by
   * member. The task service owns the interop client and its token.
   * @returns {Promise<{ok: boolean, updatedAt: string, groups: object[]}>} groups.
   */
  async conversations() {
    const tasks = this.memberTasks;
    if (tasks === void 0 || tasks === null) {
      throw Object.assign(new Error("the member task service is not available yet"), { status: 503 });
    }
    return tasks.listByMember();
  }
  /**
   * Post a message typed in the panel to selected members.
   *
   * An empty selection broadcasts to every other member; the panel resolves
   * `@3` mentions into ids before calling, so this stays a transport.
   * @param {{text?: string, members?: string[]}} request message and targets.
   * @returns {Promise<{ok: boolean, sent: object[], errors: object[]}>} outcome.
   */
  async sendConversation(request) {
    const tasks = this.memberTasks;
    if (tasks === void 0 || tasks === null) {
      throw Object.assign(new Error("the member task service is not available yet"), { status: 503 });
    }
    const text = typeof request?.text === "string" ? request.text.trim() : "";
    if (text === "") throw Object.assign(new Error("\u6D88\u606F\u4E0D\u80FD\u4E3A\u7A7A"), { status: 400 });
    if (text.length > 8e3) throw Object.assign(new Error("\u6D88\u606F\u592A\u957F\uFF08\u4E0A\u9650 8000 \u5B57\uFF09"), { status: 400 });
    const members = Array.isArray(request?.members) ? request.members.filter((item) => typeof item === "string" && item.trim() !== "") : [];
    return tasks.sendTo({ text, members });
  }
  /**
   * Ask every member's interop service to drop its finished conversations.
   * @returns {Promise<{ok: boolean, removed: number, errors: object[]}>} summary.
   */
  async clearConversations() {
    const tasks = this.memberTasks;
    if (tasks === void 0 || tasks === null) {
      throw Object.assign(new Error("the member task service is not available yet"), { status: 503 });
    }
    return tasks.clearConversations();
  }
  async members() {
    await this.#loadProbes();
    const stateFile = path18.join(this.home, "wireguard", "state.json");
    const { state, error } = await readWireGuardState({ file: stateFile });
    const identity = state === null ? null : wireGuardIdentity(state);
    const self = {
      id: "local",
      kind: "self",
      name: identity?.selfName ?? os8.hostname(),
      ip: identity?.selfIp ?? "",
      online: true,
      dsh: true,
      port: null,
      latencyMs: 0,
      gate: null,
      system: await this.systemInfo(),
      error: null
    };
    const install = this.#localAppRoot();
    if (install !== null) self.deployment = readDeployment(install.appRoot);
    const snapshot = await discoverMembers({
      state,
      stateError: error,
      self,
      ports: Array.isArray(this.config.memberPorts) ? this.config.memberPorts : [80, 8080],
      timeoutMs: PROBE_TIMEOUT_MS,
      fetchImpl: this.fetchImpl,
      geoLookup: this.geo
    });
    const tags = await this.memberTags();
    self.tag = tags[self.id] ?? null;
    const ports = Array.isArray(this.config.memberPorts) ? this.config.memberPorts : [80, 8080];
    const now = Date.now();
    let probed = false;
    const members = await Promise.all(snapshot.members.map(async (member) => {
      const tag = tags[member.id] ?? null;
      const known = this.probes.get(member.ip);
      if (member.dsh) {
        this.probes.set(member.ip, {
          port: member.port,
          gate: member.gate,
          system: member.system,
          latencyMs: member.latencyMs,
          at: now,
          expiresAt: now + PROBE_GRACE_MS
        });
        probed = true;
        return { ...member, tag };
      }
      if (known === void 0) return { ...member, tag };
      const retryPorts = known.port === null ? ports : [known.port];
      const retry = await probeMember(member.ip, {
        ports: retryPorts,
        timeoutMs: PROBE_RETRY_MS,
        fetchImpl: this.fetchImpl
      }).catch(() => null);
      if (retry !== null && retry.ok) {
        this.probes.set(member.ip, {
          port: retry.port,
          gate: retry.info,
          system: retry.info?.system ?? null,
          latencyMs: retry.latencyMs,
          at: now,
          expiresAt: now + PROBE_GRACE_MS
        });
        probed = true;
        return {
          ...member,
          dsh: true,
          port: retry.port,
          latencyMs: retry.latencyMs,
          gate: retry.info,
          system: retry.info?.system ?? null,
          error: null,
          tag
        };
      }
      if (known.expiresAt === void 0 || now > known.expiresAt) return { ...member, tag };
      return {
        ...member,
        dsh: true,
        port: known.port,
        latencyMs: known.latencyMs,
        gate: known.gate,
        system: known.system,
        error: null,
        tag,
        probeStale: true
      };
    }));
    if (probed) void this.#saveProbes();
    if (this.probes.size > 64) {
      for (const [ip, cached] of this.probes) {
        if (cached.expiresAt !== void 0 && now > cached.expiresAt) this.probes.delete(ip);
      }
    }
    return { ...snapshot, self, members, local: self };
  }
  /**
   * User labels for members, keyed by member id.
   * @returns {Promise<Record<string, string>>} tags.
   */
  async memberTags() {
    try {
      const parsed = JSON.parse(await readFile13(this.memberTagsFile, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const tags = {};
      for (const [id, tag] of Object.entries(parsed)) {
        if (typeof id === "string" && typeof tag === "string" && tag.trim() !== "") tags[id] = tag.trim().slice(0, 32);
      }
      return tags;
    } catch {
      return {};
    }
  }
  /**
   * Set or clear one member's label.
   * @param {string} id member id.
   * @param {string} tag label; empty removes it.
   * @returns {Promise<{ok: boolean, tags: Record<string, string>}>} saved tags.
   */
  async setMemberTag(id, tag) {
    if (typeof id !== "string" || id.trim() === "") throw new Error("member id is required");
    const memberId = id.trim();
    const label = typeof tag === "string" ? tag.trim().slice(0, 32) : "";
    const tags = await this.memberTags();
    if (label === "") delete tags[memberId];
    else tags[memberId] = label;
    await mkdir11(this.dataDir, { recursive: true });
    await writeFile11(this.memberTagsFile, `${JSON.stringify(tags, null, 2)}
`, "utf8");
    return { ok: true, tags };
  }
  /**
   * Remove the temporary files a build leaves behind.
   *
   * `state.json` and `build.log` are the postmortem, so they stay; the source
   * worktree, smoke screenshots, work order and extracted package trees are
   * only useful while the build runs.
   *
   * A successful job keeps its archives under `dist/` — a member build's were
   * already pulled into the packages directory, while a local build has no
   * other copy. A failed or planned job keeps nothing but the log and state: a
   * partial archive is not a deliverable.
   *
   * `needs-fix` and `learned` jobs are skipped: their worktree is the input the
   * repair/resume flow works on. `keepDist` disables the pruning entirely for
   * callers that want the whole tree (`--keep-dist`).
   * @param {{keep?: string, keepDist?: boolean}} [options] unused compatibility fields.
   * @returns {Promise<string[]>} ids whose temporary files were removed.
   */
  async cleanupBuilds(options = {}) {
    if (!existsSync11(this.jobRoot)) return [];
    const entries = await readdir7(this.jobRoot, { withFileTypes: true });
    const removed = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path18.join(this.jobRoot, entry.name);
      let state;
      try {
        state = await readState(dir);
      } catch {
        continue;
      }
      if (this.running.has(state.id) && state.id !== options.keep) continue;
      if (state.status === "created" || state.status === "needs-fix" || state.status === "learned") continue;
      await rm12(path18.join(dir, "src"), { recursive: true, force: true });
      await rm12(path18.join(dir, "smoke"), { recursive: true, force: true });
      await rm12(path18.join(dir, "work-order"), { recursive: true, force: true });
      if (options.keepDist !== true) {
        if (state.status === "done") await this.#pruneDist(path18.join(dir, "dist"));
        else await rm12(path18.join(dir, "dist"), { recursive: true, force: true });
      }
      removed.push(state.id);
    }
    return removed;
  }
  /**
   * Remove the extracted package trees from a `dist/` directory.
   *
   * Archives and their `.sha256` sidecars are files and stay untouched; the
   * per-target package directories (an `app/` + `runtime/` copy each) are the
   * part that costs a gigabyte per target.
   * @param {string} distDir job `dist/` directory.
   * @returns {Promise<void>} completion.
   */
  async #pruneDist(distDir) {
    const entries = await readdir7(distDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await rm12(path18.join(distDir, entry.name), { recursive: true, force: true });
    }
  }
  /**
   * Start one build job in the background.
   *
   * `member` chooses the build host: empty or `local` runs the engine here,
   * anything else runs the same engine on that member over SSH and copies the
   * archives back into `~/.dsh/packages`. `proxyMember` borrows another
   * member's internet access for the downloads; `proxy` is an explicit HTTP
   * proxy URL that both the engine and npm use.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string, keepDist?: boolean, member?: string, proxy?: string, proxyMember?: string}} request build request.
   * @returns {Promise<object>} the initial job state.
   */
  async startBuild(request = {}) {
    const defaults = await this.status();
    const source = (typeof request.source === "string" && request.source !== "" ? request.source : defaults.build.source) || DEFAULT_SOURCE;
    const ref = (typeof request.ref === "string" && request.ref !== "" ? request.ref : defaults.build.ref) || DEFAULT_REF;
    const targets = Array.isArray(request.targets) && request.targets.length > 0 ? request.targets : defaults.build.targets;
    const memberId = typeof request.member === "string" ? request.member.trim() : "";
    const proxyMemberId = typeof request.proxyMember === "string" ? request.proxyMember.trim() : "";
    const proxyUrl = typeof request.proxy === "string" ? request.proxy.trim() : "";
    if (this.running.size > 0) {
      throw Object.assign(new Error("a build is already running; wait for it to finish"), { status: 409 });
    }
    const snapshot = await this.members();
    const everyone = [snapshot.local, ...snapshot.members].filter((candidate) => candidate !== null && candidate !== void 0);
    let member = null;
    if (memberId !== "" && memberId !== "local") {
      const found = everyone.find((candidate) => candidate.id === memberId || candidate.name === memberId || candidate.ip === memberId);
      if (found === void 0) throw new Error(`member not found: ${memberId}`);
      if (found.id !== "local") {
        if (found.online === false) throw new Error(`member ${found.name} is offline`);
        const platform = String(found.system?.platform ?? "").toLowerCase();
        if (platform !== "" && !platform.startsWith("linux") && !platform.startsWith("win")) {
          throw new Error(`member build needs Linux or Windows; ${found.name} runs ${String(found.system?.platform)}`);
        }
        member = found;
      }
    }
    if (request.planOnly === true && member !== null) throw new Error("plan-only builds run on the local host");
    const proxyMember = proxyMemberId === "" ? null : everyone.find((candidate) => candidate.id === proxyMemberId || candidate.name === proxyMemberId || candidate.ip === proxyMemberId) ?? null;
    if (proxyMemberId !== "" && proxyMember === null) throw new Error(`proxy member not found: ${proxyMemberId}`);
    if (proxyMember !== null && proxyMember.id === "local") {
      throw new Error("the local host cannot proxy its own build; pick a member");
    }
    if (proxyMember !== null && String(proxyMember.system?.platform ?? "").toLowerCase().startsWith("win")) {
      throw new Error(`proxy member must be Linux; ${proxyMember.name} runs ${String(proxyMember.system?.platform)}`);
    }
    const buildStamp = await nextBuildStamp({
      stateFile: path18.join(this.dataDir, "build-stamp.json"),
      packagesDir: this.packagesDir
    });
    const job = await createJob({
      root: this.jobRoot,
      source,
      ref,
      targets,
      member: member?.id ?? null,
      proxy: proxyUrl !== "" ? proxyUrl : proxyMember !== null ? `member:${proxyMember.id}` : null,
      mode: member === null ? "local" : "remote",
      buildStamp
    });
    if (member !== null) {
      await updateState(job.dir, {
        memberName: member.name,
        memberIp: member.ip,
        percent: 0,
        proxyMember: proxyMember?.id ?? null
      });
    } else if (proxyMember !== null) {
      await updateState(job.dir, { proxyMember: proxyMember.id, percent: 0 });
    }
    this.logLine(`mesh build job ${job.id} created (${member === null ? "local" : member.name}${proxyMember === null ? "" : `, egress via ${proxyMember.name}`})`);
    const promise = this.#runBuild(job, {
      member,
      proxyMember,
      proxyUrl,
      planOnly: request.planOnly === true,
      version: request.version,
      buildStamp: job.state.buildStamp
    }).catch((error) => {
      this.logLine(`mesh build job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.running.delete(job.id);
    });
    this.running.set(job.id, promise);
    return { ...job.state, dir: job.dir, running: true };
  }
  /**
   * Run one build job to completion, local or on a member.
   * @param {{id: string, dir: string}} job new job.
   * @param {{member: object|null, proxyMember: object|null, proxyUrl: string, planOnly: boolean, version?: string}} options run options.
   * @returns {Promise<void>}
   */
  async #runBuild(job, options) {
    let egress = null;
    let proxyUrl = options.proxyUrl !== "" ? options.proxyUrl : null;
    const releaseConfig = await loadReleaseConfig({ file: this.releaseConfigFile });
    const publishConfigured = releaseConfig.enabled === true && (releaseConfig.github.enabled === true || releaseConfig.gitee.enabled === true);
    if (publishConfigured) {
      await appendLog(job.dir, `release publish target: ${[releaseConfig.github.enabled ? `GitHub ${releaseConfig.github.owner}/${releaseConfig.github.repo}` : "", releaseConfig.gitee.enabled ? `Gitee ${releaseConfig.gitee.owner}/${releaseConfig.gitee.repo}` : ""].filter(Boolean).join(" + ")} (tag ${releaseConfig.tag})`);
    } else {
      await appendLog(job.dir, "release publish is not configured; the build will not upload to GitHub/Gitee");
    }
    try {
      if (options.proxyMember !== null && (options.member === null || options.member.id !== options.proxyMember.id)) {
        egress = await this.egress.start({ plan: await this.#memberSshPlan(options.proxyMember), member: options.proxyMember.name });
        proxyUrl = egress.url;
        await appendLog(job.dir, `outbound proxy ${proxyUrl} (${options.proxyMember.name})`);
        await updateState(job.dir, { proxy: proxyUrl, proxyMember: options.proxyMember.id });
      }
      if (options.member === null) {
        await runJob(job.dir, {
          repositoryRoot: this.repositoryRoot,
          recipesPath: this.recipesPath,
          overlayRoot: this.overlayRoot,
          cacheDir: this.cacheDir,
          planOnly: options.planOnly,
          version: options.version,
          buildStamp: options.buildStamp,
          proxy: proxyUrl,
          publish: { config: releaseConfig, proxy: proxyUrl },
          full: this.config.build?.full !== false,
          nodeVersion: typeof this.config.build?.nodeVersion === "string" && this.config.build.nodeVersion !== "" ? this.config.build.nodeVersion : void 0,
          smoke: this.config.build?.smoke === false ? false : void 0,
          smokeRequired: this.config.build?.requireSmoke === true,
          smokeChrome: typeof this.config.build?.chrome === "string" && this.config.build.chrome !== "" ? this.config.build.chrome : void 0
        });
        return;
      }
      await this.remoteBuilder.run(job.dir, {
        plan: await this.#memberSshPlan(options.member),
        memberName: options.member.name,
        proxyUrl,
        buildStamp: options.buildStamp,
        heapMb: typeof this.config.build?.memberHeapMb === "number" ? this.config.build.memberHeapMb : void 0,
        releaseConfig: publishConfigured ? releaseConfig : null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(job.dir, `build failed to start: ${message}`).catch(() => {
      });
      await updateState(job.dir, { status: "failed", phase: "failed", error: message, percent: 0 }).catch(() => {
      });
      throw error;
    } finally {
      egress?.close();
      await this.cleanupBuilds({ keep: job.id }).catch((error) => {
        this.logLine(`mesh build cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  /**
   * SSH coordinates for one member.
   * @param {object} member member snapshot.
   * @returns {Promise<{host: string, user: string, port: number, identityFile?: string, appRoot?: string, os: string}>} plan.
   */
  async #memberSshPlan(member) {
    if (member.ip === "") throw new Error(`member ${member.name} has no VPN address`);
    let user = "root";
    let identityFile;
    let port = 22;
    const { state } = await readWireGuardState({ file: path18.join(this.home, "wireguard", "state.json") });
    const peer = state?.server?.peers?.find((candidate) => candidate?.ip === member.ip);
    if (peer !== void 0 && peer !== null) {
      if (typeof peer.sshUser === "string" && peer.sshUser !== "") user = peer.sshUser;
      if (Number.isSafeInteger(peer.sshPort)) port = peer.sshPort;
      if (typeof peer.publicKey === "string" && peer.publicKey !== "") {
        const digest = createHash7("sha256").update(peer.publicKey).digest("hex");
        const candidate = path18.join(this.home, "wireguard", "ssh", `${digest}.key`);
        if (existsSync11(candidate)) identityFile = candidate;
      }
    }
    const platform = String(member.system?.platform ?? "").toLowerCase();
    return {
      host: member.ip,
      user,
      port,
      identityFile,
      appRoot: typeof member.system?.appRoot === "string" ? member.system.appRoot : void 0,
      os: platform.startsWith("win") ? "windows" : "linux"
    };
  }
  /**
   * Run one build to completion.
   *
   * Without `jobId` this starts a fresh build. With `jobId` it treats the
   * job's worktree as the DSH-adapted result: if the job stopped at
   * `needs-fix`, it learns the corrected files into the overlay set first,
   * then resumes the same job. There is no separate learn/resume command.
   * Older jobs are cleaned only after the current job finishes, so a running
   * build never loses its own worktree or package.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string, keepDist?: boolean, jobId?: string}} request build request.
   * @returns {Promise<object>} final job with log tail.
   */
  async build(request = {}) {
    if (typeof request.jobId === "string" && request.jobId !== "") {
      const state = await this.job(request.jobId);
      if (state.status === "needs-fix") await this.learn(request.jobId);
      const resumed = await this.resumeBuild(request.jobId);
      const running2 = this.running.get(resumed.id);
      if (running2 !== void 0) await running2;
      const final2 = await this.job(resumed.id);
      await this.cleanupBuilds({ keep: resumed.id, keepDist: request.keepDist === true });
      return final2;
    }
    const job = await this.startBuild(request);
    const running = this.running.get(job.id);
    if (running !== void 0) await running;
    const final = await this.job(job.id);
    await this.cleanupBuilds({ keep: job.id, keepDist: request.keepDist === true });
    return final;
  }
  /**
   * Continue a job from its corrected worktree. This is what follows the
   * automatic learn step: the overlays have been updated, and the worktree
   * already contains the fix, so nothing is downloaded again.
   * @param {string} id job id.
   * @returns {Promise<object>} the job state, running in the background.
   */
  async resumeBuild(id) {
    const dir = this._jobDir(id);
    if (this.running.has(id)) throw new Error("this job is already running");
    const state = await readState(dir);
    this.logLine(`mesh build job ${id} resumed`);
    const releaseConfig = await loadReleaseConfig({ file: this.releaseConfigFile });
    const promise = runJob(dir, {
      repositoryRoot: this.repositoryRoot,
      publish: { config: releaseConfig, proxy: null },
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot,
      cacheDir: this.cacheDir,
      reuseWorktree: true,
      buildStamp: state.buildStamp,
      full: this.config.build?.full !== false,
      nodeVersion: typeof this.config.build?.nodeVersion === "string" && this.config.build.nodeVersion !== "" ? this.config.build.nodeVersion : void 0,
      smoke: this.config.build?.smoke === false ? false : void 0,
      smokeRequired: this.config.build?.requireSmoke === true,
      smokeChrome: typeof this.config.build?.chrome === "string" && this.config.build.chrome !== "" ? this.config.build.chrome : void 0
    }).catch((error) => {
      this.logLine(`mesh build job ${id} crashed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.running.delete(id);
    });
    this.running.set(id, promise);
    return { ...state, running: true };
  }
  /**
   * Read one job with its log tail and work-order paths.
   * @param {string} id job id.
   * @returns {Promise<object>} job detail.
   */
  async job(id) {
    const dir = this._jobDir(id);
    const state = await readState(dir);
    return {
      ...state,
      logFile: path18.join(dir, "build.log"),
      stateFile: path18.join(dir, "state.json"),
      logTail: await readLogTail(dir, 60),
      running: this.running.has(id),
      workOrderMarkdown: state.workOrder?.markdown ?? null,
      workOrderPrompt: state.workOrder?.prompt ?? null
    };
  }
  /**
   * List known jobs, newest first.
   * @returns {Promise<object[]>} jobs.
   */
  async jobs() {
    if (!existsSync11(this.jobRoot)) return [];
    const entries = await readdir7(this.jobRoot, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const state = await readState(path18.join(this.jobRoot, entry.name));
        jobs.push(this.#summary(state));
      } catch {
      }
    }
    return jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }
  /**
   * The list projection of one job, or null when it does not exist.
   *
   * The panel's event stream pushes this shape, so it is the same object
   * `jobs()` returns and the client can merge it into its table.
   * @param {string} id job id.
   * @returns {Promise<object|null>} summary.
   */
  async buildSummary(id) {
    let dir;
    try {
      dir = this._jobDir(id);
    } catch {
      return null;
    }
    try {
      return this.#summary(await readState(dir));
    } catch {
      return null;
    }
  }
  /** Project a job state onto the fields the panel lists. */
  #summary(state) {
    return {
      id: state.id,
      status: state.status,
      phase: state.phase,
      source: state.source,
      ref: state.ref,
      targets: state.targets,
      updatedAt: state.updatedAt,
      createdAt: state.createdAt,
      member: state.member ?? null,
      memberName: state.memberName ?? null,
      mode: state.mode ?? "local",
      proxy: state.proxy ?? null,
      proxyMember: state.proxyMember ?? null,
      percent: typeof state.percent === "number" ? state.percent : null,
      currentTarget: state.currentTarget ?? null,
      version: state.version ?? null,
      error: state.error ?? null,
      publish: state.publish ?? null
    };
  }
  /**
   * Read one job's log tail.
   * @param {string} id job id.
   * @param {number} [lines] number of lines.
   * @returns {Promise<string[]>} lines.
   */
  async log(id, lines = 80) {
    return readLogTail(this._jobDir(id), lines);
  }
  /**
   * Learn overlays from a corrected worktree.
   * @param {string} id job id.
   * @returns {Promise<object>} updated state.
   */
  async learn(id) {
    return learnJob(this._jobDir(id), {
      repositoryRoot: this.repositoryRoot,
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot
    });
  }
  /**
   * Read the recipe manifest summary.
   * @returns {Promise<object>} recipes.
   */
  async recipes() {
    const parsed = JSON.parse(await readFile13(this.recipesPath, "utf8"));
    return {
      source: parsed.source,
      ref: parsed.ref,
      tree: parsed.tree ?? null,
      steps: (parsed.steps ?? []).map((step) => ({
        id: step.id,
        title: step.title,
        doc: step.doc,
        files: (step.files ?? []).map((file) => ({ path: file.path, baseSha256: file.baseSha256 ?? null }))
      }))
    };
  }
  /**
   * Local deployment packages. The fixed directory is `~/.dsh/packages`.
   * @returns {Promise<object>} package list.
   */
  async packages() {
    const entries = await readdir7(this.packagesDir, { withFileTypes: true }).catch(() => []);
    const packages = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(?:zip|tar\.gz|tgz)$/iu.test(entry.name)) continue;
      const file = path18.join(this.packagesDir, entry.name);
      const info = await stat11(file).catch(() => null);
      if (info === null) continue;
      packages.push({
        name: entry.name,
        path: file,
        bytes: info.size,
        mtime: info.mtime.toISOString(),
        target: /win(?:dows)?/iu.test(entry.name) ? "windows" : "linux"
      });
    }
    packages.sort((left, right) => right.mtime.localeCompare(left.mtime));
    return { ok: true, dir: this.packagesDir, packages };
  }
  /**
   * The newest build that actually finished.
   *
   * A failed or needs-fix job must not become the baseline for the update
   * check, or one bad night would suppress the retry for every following day.
   * @returns {Promise<object|null>} job state with artifacts, or null.
   */
  async #latestDoneBuild() {
    for (const job of await this.jobs()) {
      if (job.status !== "done") continue;
      try {
        return await readState(this._jobDir(job.id));
      } catch {
      }
    }
    return null;
  }
  /**
   * Resolve the remote revisions the next build would use.
   *
   * The ETags come from codeload HEAD requests and are recorded in the package
   * manifest, so the daily check never downloads a tarball just to answer
   * "is there anything new?".
   * @param {string} source DSH source.
   * @param {string} ref DSH ref.
   * @returns {Promise<object>} current source state.
   */
  async #currentBuildSources(source, ref) {
    const extra = await readExtraPlugins(this.repositoryRoot);
    const extraPlugins = await Promise.all(extra.map(async (plugin) => ({
      name: plugin.name,
      repo: plugin.repo,
      ref: plugin.ref,
      etag: await remoteRevision(plugin.repo, plugin.ref)
    })));
    return {
      source,
      ref,
      sourceEtag: await remoteRevision(source, ref),
      pluginFingerprint: await pluginFingerprint(this.repositoryRoot),
      extraPlugins
    };
  }
  /**
   * One scheduled build: build only when DSH, dsh-mesh, or a bundled plugin
   * changed since the newest finished build.
   *
   * Returns immediately after starting the job; the build itself is the same
   * background job the panel starts.
   * @returns {Promise<{status: string, reason?: string, jobId?: string}>} outcome.
   */
  async scheduledBuild() {
    if (this.running.size > 0) return { status: "skipped", reason: "\u5DF2\u6709\u7F16\u8BD1\u4EFB\u52A1\u5728\u8FD0\u884C" };
    const jobs = await this.jobs();
    if (jobs.some((job2) => job2.status === "running" || job2.status === "created")) {
      return { status: "skipped", reason: "\u5DF2\u6709\u7F16\u8BD1\u4EFB\u52A1\u5728\u8FD0\u884C" };
    }
    const defaults = await this.status();
    const source = defaults.build.source || DEFAULT_SOURCE;
    const ref = defaults.build.ref || DEFAULT_REF;
    const targets = defaults.build.targets;
    const latest = await this.#latestDoneBuild();
    const latestManifest = latest?.artifacts?.[0]?.manifest ?? null;
    const current = await this.#currentBuildSources(source, ref);
    const reasons = buildUpdateReasons({ latestManifest, current });
    if (reasons.length === 0) {
      return { status: "skipped", reason: "DSH\u3001dsh-mesh\u3001xl \u90FD\u6CA1\u6709\u66F4\u65B0" };
    }
    const snapshot = await this.members();
    const everyone = [snapshot.local, ...snapshot.members].filter(Boolean);
    const member = pickBuildMember(everyone);
    const proxyMember = pickProxyMember(everyone);
    const job = await this.startBuild({
      source,
      ref,
      targets,
      ...member !== "local" ? { member } : {},
      ...proxyMember !== null ? { proxyMember } : {}
    });
    this.logLine(`scheduled build ${job.id} started: ${reasons.join("\uFF1B")}`);
    return {
      status: "started",
      jobId: job.id,
      reason: reasons.join("\uFF1B"),
      member: member === "local" ? "local" : member,
      proxyMember: proxyMember ?? null
    };
  }
  /**
   * Fill in a member's deployment from the newest successful deploy job.
   *
   * Old gates do not report their release; this is the same fallback the
   * member table uses, so a member that never reported a version is still
   * compared instead of being skipped forever.
   * @param {object} member member row.
   * @param {object[]} deployJobs recent deploy jobs.
   * @returns {void}
   */
  #applyInferredDeployment(member, deployJobs) {
    if (memberDeployment(member) !== null) return;
    const job = deployJobs.find((candidate) => candidate.status === "succeeded" && candidate.package !== void 0 && (candidate.member === member.id || candidate.target?.host === member.ip));
    const parsed = packageInfo(path18.basename(job?.package ?? ""));
    if (parsed === null) return;
    member.deployment = { version: parsed.version, buildStamp: parsed.buildStamp, inferred: true };
  }
  /**
   * One member's scheduled auto-upgrade.
   *
   * The job is started and left detached; the scheduler records "started"
   * instead of holding its tick open for an upload that may take minutes.
   * @param {string} memberId member id.
   * @returns {Promise<{status: string, member?: string, package?: string, jobId?: string, reason?: string}>} outcome.
   */
  async scheduledUpgradeMember(memberId) {
    if (this.running.size > 0) return { status: "skipped", reason: "\u7F16\u8BD1\u4EFB\u52A1\u8FD8\u5728\u8FD0\u884C", member: memberId };
    const snapshot = await this.members();
    const everyone = [snapshot.local, ...snapshot.members].filter(Boolean);
    const member = everyone.find((candidate) => candidate.id === memberId);
    if (member === void 0) return { status: "skipped", reason: "\u6210\u5458\u4E0D\u5728\u5F53\u524D\u5217\u8868", member: memberId };
    if (member.online === false) return { status: "skipped", reason: "\u79BB\u7EBF", member: member.name };
    const deployJobs = await this.deployJobs(50);
    this.#applyInferredDeployment(member, deployJobs);
    const packages = (await this.packages()).packages;
    const plan = planUpgrades([member], packages);
    if (plan.upgrades.length === 0) {
      return { status: "skipped", member: member.name, reason: plan.skipped[0]?.reason ?? "\u5F53\u524D\u90E8\u7F72\u5DF2\u662F\u6700\u65B0" };
    }
    const entry = plan.upgrades[0];
    try {
      const result = await this.upgradeMember({ member: entry.member.id, package: entry.package.name });
      this.logLine(`scheduled upgrade ${entry.member.name} -> ${entry.package.name} (${result.job.id})`);
      return { status: "started", member: entry.member.name, package: entry.package.name, jobId: result.job.id };
    } catch (error) {
      return { status: "failed", member: member.name, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  /**
   * One scheduled upgrade: bring every member that is behind to the newest
   * package for its OS, peers before the local gateway.
   *
   * Each member keeps its own detached job; a failure on one member does not
   * stop the others, and the local install is started last because upgrading
   * it restarts this process.
   * @returns {Promise<{status: string, reason?: string, upgraded?: object[], failed?: object[], skipped?: object[]}>} outcome.
   */
  async scheduledUpgrade() {
    if (this.running.size > 0) return { status: "skipped", reason: "\u7F16\u8BD1\u4EFB\u52A1\u8FD8\u5728\u8FD0\u884C" };
    const snapshot = await this.members();
    const everyone = [snapshot.local, ...snapshot.members].filter(Boolean);
    const deployJobs = await this.deployJobs(50);
    for (const member of everyone) this.#applyInferredDeployment(member, deployJobs);
    const packages = (await this.packages()).packages;
    const plan = planUpgrades(everyone, packages);
    const skipped2 = plan.skipped.map((entry) => ({ member: entry.member.name, reason: entry.reason }));
    if (plan.upgrades.length === 0) {
      return { status: "skipped", reason: "\u6240\u6709\u6210\u5458\u90FD\u5DF2\u7ECF\u662F\u53EF\u7528\u7684\u6700\u65B0\u90E8\u7F72", skipped: skipped2 };
    }
    const upgraded = [];
    const failed = [];
    for (const entry of plan.upgrades) {
      try {
        const result = await this.upgradeMember({ member: entry.member.id, package: entry.package.name });
        upgraded.push({ member: entry.member.name, package: entry.package.name, job: result.job.id });
        this.logLine(`scheduled upgrade ${entry.member.name} -> ${entry.package.name} (${result.job.id})`);
        if (entry.member.id === "local") continue;
        const final = await this.waitDeploy(result.job.id, { timeoutMs: 20 * 6e4 }).catch(() => null);
        if (final !== null && final.status === "failed") {
          failed.push({ member: entry.member.name, reason: final.error ?? "\u5347\u7EA7\u5931\u8D25" });
        }
      } catch (error) {
        failed.push({ member: entry.member.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      status: failed.length === 0 ? "done" : "failed",
      upgraded,
      failed,
      skipped: skipped2,
      reason: failed.length === 0 ? void 0 : `${String(failed.length)} \u4E2A\u6210\u5458\u5347\u7EA7\u5931\u8D25`
    };
  }
  /**
   * The release publishing settings the panel may see (tokens masked).
   * @returns {Promise<object>} sanitized config and the manifest URLs.
   */
  async releaseSettings() {
    const config = await loadReleaseConfig({ file: this.releaseConfigFile });
    const sanitized = sanitizeReleaseConfig(config);
    const urls = latestManifestUrls(config);
    return {
      ok: true,
      config: sanitized,
      manifestUrls: urls,
      configured: sanitized.github.enabled || sanitized.gitee.enabled
    };
  }
  /**
   * Save the release publishing settings.
   * @param {{config?: object}} request settings.
   * @returns {Promise<object>} sanitized config after the save.
   */
  async saveReleaseSettings(request) {
    const input = request?.config !== null && typeof request?.config === "object" ? request.config : request;
    const config = await saveReleaseConfig({ file: this.releaseConfigFile, input });
    this.logLine(`release settings saved (tag ${config.tag}, github ${config.github.enabled ? "on" : "off"}, gitee ${config.gitee.enabled ? "on" : "off"})`);
    return {
      ok: true,
      config: sanitizeReleaseConfig(config),
      manifestUrls: latestManifestUrls(config),
      configured: config.github.enabled || config.gitee.enabled
    };
  }
  /**
   * Delete one package (and its `.sha256` sidecar) from the packages directory.
   * @param {{name: string}} request package file name.
   * @returns {Promise<{ok: boolean, removed: string[]}>} removed files.
   */
  async removePackage(request) {
    const name = typeof request?.name === "string" ? request.name.trim() : "";
    if (name === "" || name !== path18.basename(name) || name.startsWith(".")) {
      throw new Error("package name is invalid");
    }
    if (!/\.(?:zip|tar\.gz|tgz)$/iu.test(name)) throw new Error(`not a package name: ${name}`);
    const file = path18.join(this.packagesDir, name);
    const info = await stat11(file).catch(() => null);
    if (info === null || !info.isFile()) throw new Error(`package not found: ${name}`);
    const removed = [];
    await rm12(file, { force: true });
    removed.push(file);
    const sidecar = `${file}.sha256`;
    if (existsSync11(sidecar)) {
      await rm12(sidecar, { force: true });
      removed.push(sidecar);
    }
    this.logLine(`removed package ${name}`);
    return { ok: true, removed };
  }
  /**
   * Resolve a package path from an absolute path, `~/.dsh/packages/<name>`,
   * or the repository `dist/<name>`.
   * @param {string} input package path or filename.
   * @returns {Promise<string>} absolute package path.
   */
  async resolvePackage(input) {
    const raw = typeof input === "string" ? input.trim() : "";
    if (raw === "") throw new Error("package is required");
    const candidates = path18.isAbsolute(raw) ? [raw] : [path18.join(this.packagesDir, raw), path18.join(this.repositoryRoot, "dist", raw)];
    for (const file of candidates) {
      const info = await stat11(file).catch(() => null);
      if (info?.isFile()) return file;
    }
    throw new Error(`package not found: ${raw}`);
  }
  /**
   * Resolve a target and start a deployment or upgrade job.
   *
   * The job itself runs in a detached process (`code/deploy/runner.mjs`) so a
   * member — including this gateway — can restart dsh-web and the gateway while
   * its own upgrade keeps going. This method only writes the job directory and
   * returns; `waitDeploy()` is what the model tool uses to block.
   * @param {{host?: string, member?: string, package?: string, mode?: 'install'|'upgrade'}} request target and package.
   * @returns {Promise<{ok: boolean, job: object, member: object|null, packagePath: string, layout: string}>} queued job.
   */
  async startDeploy(request) {
    const mode = request.mode === "upgrade" ? "upgrade" : request.mode === "test" ? "test" : "install";
    const test = request.test === true || mode === "test";
    const host = typeof request.host === "string" ? request.host.trim() : "";
    const memberId = typeof request.member === "string" ? request.member.trim() : "";
    const packagePath = await this.resolvePackage(request.package);
    const snapshot = await this.members();
    const all = [snapshot.local, ...snapshot.members].filter(Boolean);
    const member = memberId !== "" ? all.find((candidate) => candidate.id === memberId) : all.find((candidate) => candidate.id === host || candidate.name === host || candidate.ip === host);
    if (memberId !== "" && member === void 0) throw new Error(`member not found: ${memberId}`);
    const busy = await this.#activeDeployFor(member?.id ?? null, member?.ip ?? host);
    if (busy !== null) {
      throw Object.assign(
        new Error(`\u8BE5\u76EE\u6807\u5DF2\u6709\u6B63\u5728\u8FDB\u884C\u7684${busy.mode === "upgrade" ? "\u5347\u7EA7" : busy.mode === "test" ? "\u6D4B\u8BD5\u5347\u7EA7" : "\u90E8\u7F72"}\u4EFB\u52A1\uFF1A${busy.id}`),
        { status: 409 }
      );
    }
    if (member !== void 0) {
      const os10 = /win(?:dows)?/iu.test(path18.basename(packagePath)) ? "windows" : member.system?.platform?.toLowerCase().startsWith("win") ? "windows" : "linux";
      const identity = { id: member.id, name: member.name, ip: member.ip };
      const packageOs = /win(?:dows)?/iu.test(path18.basename(packagePath)) ? "windows" : "linux";
      if (test) assertTestUpgradeTarget(member, { packageOs });
      if (member.kind === "self" || member.id === "local") {
        return this.#startLocalJob({ member, packagePath, os: os10, mode, identity });
      }
      const deployRequest = await this.#memberDeployRequest(member, packagePath, os10);
      const download3 = mode === "install" ? null : await this.#deployDownload(request, member, all);
      const job2 = await this.#startEngineJob({
        request: { ...deployRequest, member: member.id, test, download: download3 },
        member: member.id,
        mode
      });
      return { ok: true, job: job2, member: identity, packagePath, layout: "bluegreen" };
    }
    if (host === "") throw new Error("host is required");
    if (test) throw new Error("\u6D4B\u8BD5\u5347\u7EA7\u9700\u8981\u4E00\u4E2A\u6210\u5458\uFF08\u8981\u5728\u6210\u5458\u7684\u5B89\u88C5\u4E0A\u6F14\u7EC3\uFF09\uFF0C\u4E0D\u80FD\u76F4\u63A5\u7ED9\u88F8 SSH \u4E3B\u673A");
    const os9 = /win(?:dows)?/iu.test(path18.basename(packagePath)) ? "windows" : "linux";
    const appRoot = os9 === "windows" ? "C:\\dsh-mesh" : "/opt/dsh-mesh";
    const download2 = mode === "install" ? null : await this.#deployDownload(request, null, all);
    const job = await this.#startEngineJob({ request: { host, package: packagePath, os: os9, appRoot, download: download2 }, member: null, mode });
    return { ok: true, job, member: null, packagePath, layout: "bluegreen" };
  }
  /**
   * Deploy one local package to a discovered member, without waiting.
   * Kept for the panel API, which returns a job id immediately.
   * @param {{member?: string, package?: string, mode?: 'install'|'upgrade'}} request member id/ip and package filename.
   * @returns {Promise<object>} started deploy job.
   */
  async deployMember(request) {
    const result = await this.startDeploy({ member: request.member, package: request.package, mode: request.mode });
    return {
      ok: true,
      job: result.job,
      member: result.member,
      layout: result.layout,
      packagesDir: this.packagesDir
    };
  }
  /**
   * Upgrade one member (or this machine) from a chosen deployment package.
   *
   * Same flow as a first deploy; the difference is that an installed member is
   * upgraded by the package instead of being installed from scratch, and the
   * panel labels the job as an upgrade.
   * @param {{member?: string, package?: string}} request member id/ip and package filename.
   * @returns {Promise<object>} queued job.
   */
  async upgradeMember(request) {
    const result = await this.startDeploy({
      member: request.member,
      package: request.package,
      mode: "upgrade",
      ...typeof request.proxyMember === "string" ? { proxyMember: request.proxyMember } : {},
      ...request.direct === true ? { direct: true } : {}
    });
    return {
      ok: true,
      job: result.job,
      member: result.member,
      layout: result.layout,
      packagesDir: this.packagesDir
    };
  }
  /**
   * Test-upgrade one package on another member.
   *
   * The job does what a member upgrade does — upload, extract, switch, restart,
   * health check, rollback on failure — and, before touching the member, runs
   * the flat upgrade the gateway runs on itself against a sandbox built from
   * the member's current version. That way the local path is exercised on a
   * machine that is not this one.
   * @param {{member?: string, package?: string}} request member id/ip and package filename.
   * @returns {Promise<object>} queued job.
   */
  async testUpgradeMember(request) {
    const result = await this.startDeploy({
      member: request.member,
      package: request.package,
      mode: "test",
      test: true,
      ...typeof request.proxyMember === "string" ? { proxyMember: request.proxyMember } : {},
      ...request.direct === true ? { direct: true } : {}
    });
    return {
      ok: true,
      job: result.job,
      member: result.member,
      layout: result.layout,
      packagesDir: this.packagesDir
    };
  }
  /**
   * Deploy one package to an SSH host, synchronously.
   *
   * The host may be a discovered member id/name/IP, in which case the member's
   * OS, install root and WireGuard SSH metadata are used; otherwise the host is
   * treated as a plain SSH target and the package platform decides the OS.
   * @param {{host?: string, package?: string, mode?: 'install'|'upgrade'}} request target host and package.
   * @returns {Promise<{job: object|null, logFile: string, log: string, member?: object}>} final result.
   */
  async deployPackage(request) {
    const started = await this.startDeploy({ host: request.host, package: request.package, mode: request.mode });
    const job = await this.waitDeploy(started.job.id);
    return {
      job,
      member: started.member,
      logFile: path18.join(this.deployRoot, started.job.id, "deploy.log"),
      log: await this.deployLogs(started.job.id, 80)
    };
  }
  /**
   * The job currently using one target, if any.
   * @param {string|null} memberId member id.
   * @param {string} host VPN address or SSH host.
   * @returns {Promise<object|null>} active job.
   */
  async #activeDeployFor(memberId, host) {
    for (const job of await this.deploy.list(20)) {
      if (job.status !== "running" && job.status !== "queued") continue;
      if (memberId !== null && memberId !== "" && job.member === memberId) return job;
      if (typeof host === "string" && host !== "" && job.target?.host === host) return job;
    }
    return null;
  }
  /**
   * Wait for one detached deploy job to settle.
   * @param {string} id job id.
   * @param {{timeoutMs?: number}} [options] budget; 30 minutes by default.
   * @returns {Promise<object|null>} final job state.
   */
  async waitDeploy(id, options = {}) {
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30 * 60 * 1e3;
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      const job = await this.deployStatus(id);
      if (job !== null && job.status !== "running" && job.status !== "queued") return job;
      if (Date.now() >= deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, 1e3));
    }
  }
  /**
   * Start one job for a blue-green target (blue-green members and plain hosts).
   *
   * The plan is built here, once: the queued job needs its release name and
   * size, and the runner must not hash a 300 MB package a second time.
   * @param {{request: object, member: string|null, mode: 'install'|'upgrade'}} input job input.
   * @returns {Promise<object>} queued job state.
   */
  async #startEngineJob(input) {
    const plan = await buildDeployPlan({
      ...input.request,
      gatePassword: typeof input.request.gatePassword === "string" ? input.request.gatePassword : process.env.DSH_GATE_PASSWORD,
      repositoryRoot: this.repositoryRoot
    });
    return this.#queueJob({
      mode: input.mode,
      member: input.member,
      plan,
      request: { kind: "engine", plan, options: { ...input.request, plan, mode: input.mode } }
    });
  }
  /**
   * Start the local upgrade, or a local blue-green deploy, whichever the
   * install layout supports.
   *
   * A flat install (gateway) has no release symlink to switch: the package's
   * own `upgrade-local.sh` copies the new tree over it. A blue-green install
   * upgrades exactly like a member, using a local runner instead of SSH.
   * @param {{member: object, packagePath: string, os: string, mode: 'install'|'upgrade', identity: object}} input target.
   * @returns {Promise<object>} queued job and its layout.
   */
  async #startLocalJob(input) {
    const install = this.#localAppRoot();
    if (install === null) {
      throw new Error("\u672C\u673A\u6CA1\u6709\u53EF\u8BC6\u522B\u7684 dsh-mesh \u5B89\u88C5\u76EE\u5F55\uFF08\u627E\u4E0D\u5230 config/gate.env\uFF09\uFF0C\u65E0\u6CD5\u5347\u7EA7\u672C\u673A");
    }
    if (input.os === "windows" && install.layout === "flat") {
      throw new Error("\u672C\u673A\u662F Linux \u7F51\u5173\uFF0C\u4E0D\u80FD\u5B89\u88C5 Windows \u90E8\u7F72\u5305");
    }
    if (install.layout === "flat") {
      const job2 = await this.#queueJob({
        mode: input.mode,
        member: "local",
        plan: null,
        request: { kind: "inplace", inplace: { package: input.packagePath, appRoot: install.appRoot } },
        target: { host: "127.0.0.1", user: os8.userInfo().username, port: null, os: "linux", appRoot: install.appRoot },
        services: ["dsh-web-app.service", "dsh-web-gate.service", "dsh-wireguard-control.service", "dsh-interop.service"],
        packagePath: input.packagePath,
        release: path18.basename(input.packagePath)
      });
      return { ok: true, job: job2, member: input.identity, packagePath: input.packagePath, layout: "flat" };
    }
    const job = await this.#startEngineJob({
      request: { host: "127.0.0.1", local: true, package: input.packagePath, os: input.os, appRoot: install.appRoot, member: input.member.id },
      member: input.member.id,
      mode: input.mode
    });
    return { ok: true, job, member: input.identity, packagePath: input.packagePath, layout: "bluegreen" };
  }
  /**
   * Write one queued job directory and spawn its detached runner.
   * @param {{mode: string, member: string|null, plan: object|null, request: object, target?: object, services?: string[], packagePath?: string, release?: string}} job job input.
   * @returns {Promise<object>} queued job state.
   */
  async #queueJob(job) {
    const id = newJobId();
    const dir = path18.join(this.deployRoot, id);
    await mkdir11(dir, { recursive: true });
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const bytes = job.plan?.package?.bytes ?? (await stat11(job.packagePath).catch(() => null))?.size ?? 0;
    const state = {
      id,
      mode: job.mode,
      createdAt: now,
      updatedAt: now,
      member: job.member,
      target: job.plan === null ? job.target : { host: job.plan.host, user: job.plan.user ?? null, port: job.plan.port, os: job.plan.os, appRoot: job.plan.appRoot },
      release: job.plan?.release ?? job.release ?? "local",
      package: job.plan?.package?.path ?? job.packagePath ?? null,
      services: job.plan === null ? job.services ?? [] : job.plan.services.map((service) => service.name),
      status: "queued",
      phase: "starting",
      error: null,
      steps: initialDeploySteps({ test: job.plan?.test === true, os: job.plan?.os }),
      progress: { label: "\u542F\u52A8\u72EC\u7ACB\u5347\u7EA7\u8FDB\u7A0B", percent: 0, bytes: 0, totalBytes: bytes, speed: 0, indeterminate: false }
    };
    await writeDeployState(dir, state);
    const requestFile = jobPaths(dir).request;
    await writeFile11(requestFile, `${JSON.stringify({ ...job.request, id, member: job.member }, null, 2)}
`, { encoding: "utf8", mode: 384 });
    const spawned = await this.spawnRunner(dir, id);
    await appendDeployLog(dir, `job queued; runner ${spawned.mode}${spawned.unit === null ? "" : ` (${spawned.unit})`}`);
    this.logLine(`mesh ${job.mode} job ${id} queued for ${state.target.host} via ${spawned.mode}`);
    return state;
  }
  /**
   * Start the detached runner for one job.
   *
   * `systemd-run` is preferred: a service restart kills its whole cgroup, so a
   * plain detached child of dsh-web would not survive the very restart it is
   * deploying. The transient unit puts the runner in its own cgroup; when
   * systemd is unavailable the plain detached spawn still survives the parent.
   * @param {string} dir job directory.
   * @param {string} id job id.
   * @returns {Promise<{mode: string, unit: string|null}>} how it was started.
   */
  async #spawnRunner(dir, id) {
    const script = path18.join(this.repositoryRoot, "code", "deploy", "runner.mjs");
    if (!existsSync11(script)) throw new Error(`deploy runner is missing: ${script}`);
    const node = process.execPath;
    const unit = `dsh-mesh-job-${id.replace(/^deploy-/u, "")}`;
    const systemdRun = ["/usr/bin/systemd-run", "/bin/systemd-run"].find((file) => existsSync11(file));
    if (systemdRun !== void 0 && process.platform === "linux" && process.getuid?.() === 0) {
      const result = await new Promise((resolve) => {
        const child2 = spawn6(systemdRun, [
          "--unit",
          unit,
          "--collect",
          "--description",
          `dsh-mesh ${id}`,
          "--setenv",
          `DSH_MESH_JOB_UNIT=${unit}`,
          node,
          script,
          "--job",
          dir
        ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        let stderr = "";
        child2.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child2.once("error", (error) => resolve({ ok: false, detail: error.message }));
        child2.once("exit", (code) => resolve({ ok: code === 0, detail: stderr.trim() }));
      });
      if (result.ok) return { mode: "systemd-run", unit };
      await appendDeployLog(dir, `systemd-run failed, falling back to a detached process: ${result.detail}`);
    }
    const child = spawn6(node, [script, "--job", dir], {
      cwd: this.repositoryRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, DSH_MESH_JOB_UNIT: "" }
    });
    child.unref();
    return { mode: "detached", unit: null };
  }
  /**
   * Locate the install that owns this plugin.
   * @returns {{appRoot: string, layout: 'flat'|'bluegreen'}|null} install, or null in a source checkout.
   */
  #localAppRoot() {
    let candidate = path18.resolve(this.repositoryRoot, "..");
    for (let depth = 0; depth < 5; depth += 1) {
      const parent = path18.dirname(candidate);
      const current = path18.join(parent, "current");
      if (existsSync11(current)) {
        try {
          if (realpathSync2(candidate) === realpathSync2(current)) return { appRoot: parent, layout: "bluegreen" };
        } catch {
        }
      }
      if (existsSync11(path18.join(candidate, "current")) && existsSync11(path18.join(candidate, "releases"))) {
        return { appRoot: candidate, layout: "bluegreen" };
      }
      if (existsSync11(path18.join(candidate, "config", "gate.env")) && existsSync11(path18.join(candidate, "plugins", "dsh-mesh"))) {
        return { appRoot: candidate, layout: "flat" };
      }
      if (parent === candidate) break;
      candidate = parent;
    }
    return null;
  }
  /**
   * Empty one finished build job's log.
   * @param {string} id job id.
   * @returns {Promise<{ok: boolean, id: string}>} result.
   */
  async clearBuildLog(id) {
    const dir = this._jobDir(id);
    const state = await readState(dir).catch(() => null);
    if (state === null) throw new Error(`build job not found: ${id}`);
    if (this.running.has(state.id) || state.status === "running") {
      throw new Error("\u7F16\u8BD1\u8FD8\u5728\u8FD0\u884C\uFF0C\u7ED3\u675F\u540E\u518D\u6E05\u7A7A\u65E5\u5FD7");
    }
    await writeFile11(path18.join(dir, "build.log"), "", "utf8");
    return { ok: true, id: state.id };
  }
  /**
   * Drop every finished build job: its record, its log and its worktree.
   *
   * Truncating `build.log` alone looked like a no-op in the panel, because the
   * row stayed in the table. The bulk action now deletes the job directory, so
   * the list really goes back to empty; the archives themselves were already
   * copied to `~/.dsh/packages`, which this never touches. A running or queued
   * job is left alone.
   * @returns {Promise<{ok: boolean, cleared: string[]}>} cleared job ids.
   */
  async clearFinishedBuilds() {
    const cleared = [];
    const entries = await readdir7(this.jobRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path18.join(this.jobRoot, entry.name);
      const state = await readState(dir).catch(() => null);
      if (state === null) continue;
      if (this.running.has(state.id) || state.status === "running" || state.status === "queued") continue;
      await rm12(dir, { recursive: true, force: true });
      cleared.push(state.id);
    }
    return { ok: true, cleared };
  }
  /**
   * Decide how an upgrade should obtain its package from a release.
   *
   * The default is the same policy the build panel uses: a foreign Linux
   * member with external access hosts the HTTP proxy, so the target's download
   * leaves through that network instead of the gateway's. A caller can pick a
   * different member with `proxyMember`, or skip the proxy with `direct: true`
   * (the member's own network is then used).
   * @param {{proxyMember?: string, direct?: boolean}} request deploy request.
   * @param {object|null} target the member being upgraded, when it is one.
   * @param {object[]} everyone local + peer rows.
   * @returns {Promise<object|null>} download spec for the deploy plan.
   */
  async #deployDownload(request, target, everyone) {
    const releaseConfig = await loadReleaseConfig({ file: this.releaseConfigFile });
    const sources = latestManifestSources(releaseConfig);
    const manifests = [];
    if (sources.github !== null) manifests.push({ provider: "github", url: sources.github });
    if (sources.gitee !== null) manifests.push({ provider: "gitee", url: sources.gitee });
    if (manifests.length === 0) return null;
    if (request.direct === true || request.proxyMember === "none") return { manifests, proxy: null };
    const wanted = typeof request.proxyMember === "string" ? request.proxyMember.trim() : "";
    let proxyMember = null;
    if (wanted !== "" && wanted !== "auto") {
      proxyMember = everyone.find((candidate) => candidate.id === wanted || candidate.name === wanted || candidate.ip === wanted) ?? null;
      if (proxyMember === null) throw new Error(`download proxy member not found: ${wanted}`);
      if (proxyMember.id === "local" || proxyMember.kind === "self") throw new Error("the gateway cannot proxy a member download; pick another member");
      const platform = String(proxyMember.system?.platform ?? "").toLowerCase();
      if (platform !== "" && !platform.startsWith("linux")) throw new Error(`download proxy member must be Linux; ${proxyMember.name} runs ${String(proxyMember.system?.platform)}`);
    } else {
      const picked = pickProxyMember(everyone);
      proxyMember = picked === null ? null : everyone.find((candidate) => candidate.id === picked) ?? null;
    }
    if (proxyMember === null) return { manifests, proxy: null };
    const plan = await this.#memberSshPlan(proxyMember);
    return {
      manifests,
      proxy: {
        host: plan.host,
        user: plan.user,
        port: plan.port,
        identityFile: plan.identityFile,
        appRoot: plan.appRoot,
        name: proxyMember.name
      }
    };
  }
  /**
   * Build the deployment request for a discovered member.
   * @param {object} member member snapshot.
   * @param {string} packagePath package file.
   * @param {'linux'|'windows'} os target OS.
   * @returns {Promise<object>} deploy request.
   */
  async #memberDeployRequest(member, packagePath, os9) {
    if (member.ip === "") throw new Error(`member ${member.id} has no VPN address`);
    let user = "root";
    let identityFile;
    const { state } = await readWireGuardState({ file: path18.join(this.home, "wireguard", "state.json") });
    const peer = state?.server?.peers?.find((candidate) => candidate?.ip === member.ip);
    if (peer !== void 0 && peer !== null) {
      if (typeof peer.sshUser === "string" && peer.sshUser !== "") user = peer.sshUser;
      if (typeof peer.publicKey === "string" && peer.publicKey !== "") {
        const digest = createHash7("sha256").update(peer.publicKey).digest("hex");
        const candidate = path18.join(this.home, "wireguard", "ssh", `${digest}.key`);
        if (existsSync11(candidate)) identityFile = candidate;
      }
    }
    const system = member.system;
    let appRoot = normalizeInstallRoot(system?.appRoot) || void 0;
    let serviceUser = typeof system?.user === "string" && system.user.trim() !== "" ? system.user.trim() : void 0;
    if (appRoot === void 0) {
      try {
        const detected = await this.deploy.inspectTarget({ host: member.ip, user, identityFile, os: os9 });
        appRoot = detected.appRoot;
        serviceUser = serviceUser ?? detected.serviceUser;
      } catch {
      }
    }
    if (appRoot === void 0 && typeof system?.home === "string" && system.home.trim() !== "") {
      const home = system.home.trim().replace(/[\\/]+$/u, "");
      appRoot = os9 === "windows" ? `${home}\\.dsh\\dsh-mesh` : `${home}/.dsh/dsh-mesh`;
    }
    if (appRoot === void 0) {
      const home = os9 === "windows" ? `C:\\Users\\${user}` : user === "root" ? "/root" : `/home/${user}`;
      appRoot = os9 === "windows" ? `${home}\\.dsh\\dsh-mesh` : `${home}/.dsh/dsh-mesh`;
    }
    return {
      host: member.ip,
      user,
      identityFile,
      os: os9,
      appRoot,
      serviceUser,
      package: packagePath
    };
  }
  /**
   * Refresh a prebuilt package from this repository, in place.
   *
   * The DSH app, the browser bundles and the Node runtime inside the package
   * stay as they are; only the gateway, the scripts and the plugin files are
   * replaced, then the archive and its checksum are rewritten.
   * @param {{package: string}} request package name (in the packages dir) or path.
   * @returns {Promise<object>} summary.
   */
  async repackPackage(request) {
    const packagePath = await this.resolvePackage(request.package);
    const summary = await repackArchive(packagePath, {
      repositoryRoot: this.repositoryRoot,
      log: (line) => this.logLine(`repack: ${line}`)
    });
    return { ok: true, ...summary };
  }
  /**
   * Plan an SSH blue-green deployment without touching the network.
   * @param {object} request deploy options.
   * @returns {Promise<object>} plan.
   */
  async deployPlan(request) {
    return this.deploy.plan(request);
  }
  /**
   * Start an SSH blue-green deployment.
   * @param {object} request deploy options.
   * @returns {Promise<object>} job.
   */
  async deployStart(request) {
    return this.deploy.start(request);
  }
  /**
   * Read one deployment job.
   * @param {string} id job id.
   * @returns {Promise<object|null>} job state.
   */
  async deployStatus(id) {
    return this.deploy.status(id);
  }
  /**
   * List recent deployment jobs, newest first.
   * @param {number} [limit] maximum count.
   * @returns {Promise<object[]>} jobs.
   */
  async deployJobs(limit = 20) {
    return this.deploy.list(limit);
  }
  /**
   * Read one deployment job's log tail.
   * @param {string} id job id.
   * @param {number} [lines] line count.
   * @returns {Promise<string>} log tail.
   */
  async deployLogs(id, lines = 80) {
    return this.deploy.logs(id, lines);
  }
  /**
   * Roll a deployment back to the previous release.
   * @param {object} request deploy target options.
   * @returns {Promise<object>} job.
   */
  async deployRollback(request) {
    return this.deploy.rollback(request);
  }
  /**
   * Roll one discovered member back to the release it ran before the last
   * deploy.
   *
   * This is the escape hatch for "the upgrade came up broken": the panel that
   * started the upgrade is still alive (it is a different machine), so it can
   * put the member back without a shell. A flat install has no blue-green
   * `previous`, so it is refused with a pointer at its upgrade backup.
   * @param {{member: string}} request member id, VPN address, or name.
   * @returns {Promise<object>} rollback job.
   */
  async rollbackMember({ member = "" } = {}) {
    if (member === "") throw new Error("which member should roll back?");
    const snapshot = await this.members();
    const everyone = [snapshot.local, ...snapshot.members].filter((entry) => entry !== null && entry !== void 0);
    const found = everyone.find((entry) => entry.id === member || entry.name === member || entry.ip === member);
    if (found === void 0) throw new Error(`member not found: ${member}`);
    if (found.kind === "self") {
      throw new Error("\u672C\u673A\u662F\u5E73\u94FA\u5B89\u88C5\uFF0C\u6CA1\u6709 blue-green \u7684\u4E0A\u4E00\u7248\u53EF\u5207\uFF1B\u56DE\u6EDA\u7528 .upgrade-backup \u91CC\u7684\u5907\u4EFD\u6062\u590D");
    }
    if (found.dsh !== true) {
      throw new Error(`\u6210\u5458 ${found.name} \u7684\u7F51\u5173\u6CA1\u6709\u5E94\u7B54\uFF0C\u65E0\u6CD5\u5728\u7EBF\u56DE\u6EDA\uFF1BSSH \u4E0A\u53BB\u6267\u884C code/deploy/cli.mjs rollback`);
    }
    const os9 = String(found.system?.platform ?? "").toLowerCase().startsWith("win") ? "windows" : "linux";
    const request = await this.#memberDeployRequest(found, "", os9);
    const rolled = await this.deploy.rollback({ ...request, os: os9, skipPackage: true });
    return { ok: true, job: rolled.job ?? rolled, member: found };
  }
  /**
   * Resolve and validate one job directory.
   * @param {string} id job id.
   * @returns {string} path.
   */
  _jobDir(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/u.test(id)) throw new Error("invalid job id");
    const dir = path18.resolve(this.jobRoot, id);
    if (!dir.startsWith(`${path18.resolve(this.jobRoot)}${path18.sep}`)) throw new Error("invalid job id");
    return dir;
  }
};

// code/shared/event-stream.mjs
import { mkdirSync, readdirSync, watch } from "node:fs";
import path19 from "node:path";
var HEARTBEAT_MS = 15e3;
var DEBOUNCE_MS = 120;
var EventHub = class {
  /**
   * @param {{log?: (line: string) => void, heartbeatMs?: number}} [options] options.
   */
  constructor(options = {}) {
    this.log = options.log ?? (() => {
    });
    this.heartbeatMs = Number.isSafeInteger(options.heartbeatMs) ? options.heartbeatMs : HEARTBEAT_MS;
    this.clients = /* @__PURE__ */ new Set();
  }
  /** How many panels are currently subscribed. */
  get size() {
    return this.clients.size;
  }
  /**
   * Turn one HTTP response into a long-lived event stream.
   *
   * The caller must not write to the response afterwards. The returned
   * unsubscribe function is idempotent, so both request and response `close`
   * handlers can call it.
   * @param {import('node:http').IncomingMessage} request request.
   * @param {import('node:http').ServerResponse} response response.
   * @returns {() => void} unsubscribe.
   */
  subscribe(request, response) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    try {
      response.write("retry: 3000\n\n");
      response.write(`event: ready
data: ${JSON.stringify({ type: "ready" })}

`);
    } catch {
      try {
        response.end();
      } catch {
      }
      return () => {
      };
    }
    this.clients.add(response);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      this.clients.delete(response);
    };
    const heartbeat = setInterval(() => {
      try {
        response.write(": ping\n\n");
      } catch {
        close();
      }
    }, this.heartbeatMs);
    heartbeat.unref?.();
    request.once("close", close);
    response.once("close", close);
    return close;
  }
  /**
   * Send one named event to every subscriber.
   * @param {string} type event name.
   * @param {object} payload JSON payload.
   * @returns {void}
   */
  send(type, payload) {
    if (this.clients.size === 0) return;
    const frame = `event: ${type}
data: ${JSON.stringify(payload)}

`;
    for (const client of [...this.clients]) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }
  /** Close every stream, e.g. when the plugin is unloaded. */
  close() {
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch {
      }
    }
    this.clients.clear();
  }
};
var JobDirectoryWatcher = class {
  /**
   * @param {{root: string, onChange: (dir: string, file: string) => void, log?: (line: string) => void}} options options.
   */
  constructor(options) {
    this.root = options.root;
    this.onChange = options.onChange;
    this.log = options.log ?? (() => {
    });
    this.watchers = /* @__PURE__ */ new Map();
    this.pending = /* @__PURE__ */ new Map();
    this.rootWatcher = null;
    this.timer = null;
    this.started = false;
  }
  /** Start watching. Safe to call twice. */
  start() {
    if (this.started) return;
    this.started = true;
    try {
      mkdirSync(this.root, { recursive: true });
      this.rootWatcher = watch(this.root, { persistent: false }, (_event, file) => {
        this.#scan();
        this.#queue("", String(file ?? ""));
      });
      this.rootWatcher.on("error", (error) => this.#fail(error));
    } catch (error) {
      this.#fail(error);
      return;
    }
    this.#scan();
  }
  /** Stop every watcher and drop pending callbacks. */
  stop() {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.rootWatcher?.close();
    this.rootWatcher = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
  /** Add a watcher for every immediate subdirectory not seen yet. */
  #scan() {
    let entries = [];
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || this.watchers.has(entry.name)) continue;
      try {
        const watcher = watch(path19.join(this.root, entry.name), { persistent: false }, (_event, file) => {
          this.#queue(entry.name, String(file ?? ""));
        });
        watcher.on("error", () => {
          this.watchers.delete(entry.name);
        });
        this.watchers.set(entry.name, watcher);
      } catch {
      }
    }
  }
  /** Batch one change and deliver it after a short debounce. */
  #queue(dir, file) {
    this.pending.set(`${dir}\0${file}`, { dir, file });
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const changes = [...this.pending.values()];
      this.pending.clear();
      for (const change of changes) {
        try {
          this.onChange(change.dir, change.file);
        } catch (error) {
          this.log(`event watcher callback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }, DEBOUNCE_MS);
    this.timer.unref?.();
  }
  /** Report a watcher that could not even be created. */
  #fail(error) {
    this.log(`cannot watch ${this.root}: ${error instanceof Error ? error.message : String(error)}`);
    this.rootWatcher?.close();
    this.rootWatcher = null;
  }
};

// src/lib/job-events.mjs
import path20 from "node:path";
var LOG_THROTTLE_MS = 400;
var LOG_LINES = 300;
var JOB_ID = /^[A-Za-z0-9._-]+$/u;
function startJobEvents(options) {
  const { service, hub } = options;
  const log = options.log ?? (() => {
  });
  const logTimers = /* @__PURE__ */ new Map();
  const reading = /* @__PURE__ */ new Map();
  if (typeof service.dataDir !== "string" || service.dataDir === "") {
    log("job events disabled: the service has no dataDir");
    return { close() {
    } };
  }
  const watchers = [
    new JobDirectoryWatcher({
      root: path20.join(service.dataDir, "build"),
      log,
      onChange: (dir, file) => handle("build", dir, file)
    }),
    new JobDirectoryWatcher({
      root: path20.join(service.dataDir, "deploy"),
      log,
      onChange: (dir, file) => handle("deploy", dir, file)
    })
  ];
  for (const watcher of watchers) watcher.start();
  function handle(kind, dir, file) {
    const id = dir !== "" ? dir : file;
    if (typeof id !== "string" || id === "" || !JOB_ID.test(id)) return;
    if (dir === "") {
      void emit(kind, id);
      return;
    }
    if (file === "" || file === "state.json" || file === "job.json") {
      void emit(kind, id);
      return;
    }
    if (file.endsWith(".log")) scheduleLog(kind, id);
  }
  async function emit(kind, id) {
    const key = `${kind}:${id}`;
    if (reading.get(key) === true) return;
    reading.set(key, true);
    try {
      const job = kind === "build" ? await service.buildSummary(id) : await service.deployStatus(id);
      if (job === null || job === void 0) return;
      hub.send(kind, { type: kind, id, job });
    } catch (error) {
      log(`job event for ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      reading.delete(key);
    }
  }
  function scheduleLog(kind, id) {
    const key = `${kind}:${id}`;
    if (logTimers.has(key)) return;
    const timer = setTimeout(() => {
      logTimers.delete(key);
      void sendLog(kind, id);
    }, LOG_THROTTLE_MS);
    timer.unref?.();
    logTimers.set(key, timer);
  }
  async function sendLog(kind, id) {
    try {
      const tail = kind === "build" ? await service.log(id, LOG_LINES) : await service.deployLogs(id, LOG_LINES);
      const lines = Array.isArray(tail) ? tail.filter((line) => typeof line === "string") : typeof tail === "string" && tail.trim() !== "" ? tail.trimEnd().split(/\r?\n/u) : [];
      hub.send(`${kind}-log`, { type: `${kind}-log`, id, lines });
    } catch (error) {
      log(`job log for ${kind}:${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    close() {
      for (const watcher of watchers) watcher.stop();
      for (const timer of logTimers.values()) clearTimeout(timer);
      logTimers.clear();
      reading.clear();
    }
  };
}

// src/lib/http-api.mjs
var API_PREFIX = "/api/dsh-mesh";
var AGENT_HEADER = "x-dsh-mesh";
var MAX_BODY_BYTES = 64 * 1024;
function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}
async function readJson2(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
  return parsed;
}
function registerApi(ctx, service, scheduler = null) {
  const hub = new EventHub({ log: (line) => ctx.logger?.info?.(`mesh events: ${line}`) });
  const jobEvents = startJobEvents({ service, hub, log: (line) => ctx.logger?.warn?.(`mesh events: ${line}`) });
  ctx.effect(() => () => {
    jobEvents.close();
    hub.close();
  }, "mesh events");
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", "http://local.invalid");
        const path25 = url.pathname.slice(API_PREFIX.length) || "/";
        if (method === "GET" && path25 === "/status") {
          writeJson(response, 200, await service.status());
          return;
        }
        if (method === "GET" && path25 === "/members") {
          writeJson(response, 200, await service.members());
          return;
        }
        if (method === "GET" && path25 === "/member-tags") {
          writeJson(response, 200, { ok: true, tags: await service.memberTags() });
          return;
        }
        if (method === "GET" && path25 === "/schedule") {
          if (scheduler === null) {
            writeJson(response, 503, { ok: false, error: { code: "unavailable", message: "\u5B9A\u65F6\u4EFB\u52A1\u8FD8\u6CA1\u6709\u542F\u52A8\u3002" } });
            return;
          }
          const member = url.searchParams.get("member") ?? "";
          writeJson(response, 200, { ok: true, schedule: scheduler.status(member === "" ? void 0 : member) });
          return;
        }
        if (method === "POST" && path25 === "/packages/delete") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.removePackage({ name: typeof body.name === "string" ? body.name : "" }));
          return;
        }
        if (method === "POST" && path25 === "/conversations/send") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.sendConversation({
            text: typeof body.text === "string" ? body.text : "",
            members: Array.isArray(body.members) ? body.members.filter((item) => typeof item === "string") : []
          }));
          return;
        }
        if (method === "POST" && path25 === "/conversations/clear") {
          writeJson(response, 200, await service.clearConversations());
          return;
        }
        if (method === "GET" && path25 === "/conversations") {
          writeJson(response, 200, await service.conversations());
          return;
        }
        if (method === "GET" && path25 === "/events") {
          hub.subscribe(request, response);
          return;
        }
        if (method === "GET" && path25 === "/jobs") {
          writeJson(response, 200, { ok: true, jobs: await service.jobs() });
          return;
        }
        if (method === "GET" && path25 === "/packages") {
          writeJson(response, 200, await service.packages());
          return;
        }
        if (method === "GET" && path25 === "/release") {
          writeJson(response, 200, await service.releaseSettings());
          return;
        }
        if (method === "GET" && path25 === "/deploy/jobs") {
          writeJson(response, 200, { ok: true, jobs: await service.deployJobs(30) });
          return;
        }
        if (method === "GET") {
          const deployRead = /^\/deploy\/([^/]+)(\/log)?$/u.exec(path25);
          if (deployRead !== null) {
            const lines = Number.parseInt(url.searchParams.get("lines") ?? "200", 10);
            const job = await service.deployStatus(deployRead[1]);
            if (job === null) {
              writeJson(response, 404, { ok: false, error: { code: "not_found", message: "Unknown deploy job." } });
              return;
            }
            const tail = await service.deployLogs(deployRead[1], Number.isSafeInteger(lines) ? Math.min(Math.max(lines, 1), 500) : 200);
            writeJson(response, 200, {
              ok: true,
              job,
              // Match the build log endpoint: the panel expects an array.
              lines: tail.trimEnd() === "" ? [] : tail.trimEnd().split(/\r?\n/u)
            });
            return;
          }
          const read = /^\/build\/([^/]+)(\/log)?$/u.exec(path25);
          if (read !== null) {
            if (read[2] === "/log") {
              const lines = Number.parseInt(url.searchParams.get("lines") ?? "80", 10);
              writeJson(response, 200, {
                ok: true,
                lines: await service.log(read[1], Number.isSafeInteger(lines) ? Math.min(Math.max(lines, 1), 500) : 80)
              });
              return;
            }
            writeJson(response, 200, { ok: true, job: await service.job(read[1]) });
            return;
          }
        }
        if (method !== "POST") {
          writeJson(response, 405, { ok: false, error: { code: "method_not_allowed", message: "Use GET or POST." } });
          return;
        }
        if (request.headers[AGENT_HEADER] !== "1") {
          writeJson(response, 403, { ok: false, error: { code: "forbidden", message: `Missing the ${AGENT_HEADER} header.` } });
          return;
        }
        if (method === "POST" && path25 === "/release") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.saveReleaseSettings(body));
          return;
        }
        if (path25 === "/deploy") {
          const body = await readJson2(request);
          const result = await service.deployMember({
            member: typeof body.member === "string" ? body.member : void 0,
            package: typeof body.package === "string" ? body.package : void 0
          });
          writeJson(response, 202, result);
          return;
        }
        if (path25 === "/session/promote") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.promoteSession(String(body.member ?? "")));
          return;
        }
        if (path25 === "/member-tags") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.setMemberTag(
            typeof body.id === "string" ? body.id : "",
            typeof body.tag === "string" ? body.tag : ""
          ));
          return;
        }
        const clearLog = /^\/build\/([^/]+)\/log\/clear$/u.exec(path25);
        if (clearLog !== null) {
          writeJson(response, 200, await service.clearBuildLog(clearLog[1]));
          return;
        }
        if (path25 === "/build/logs/clear") {
          writeJson(response, 200, await service.clearFinishedBuilds());
          return;
        }
        if (path25 === "/deploy/rollback") {
          const body = await readJson2(request);
          writeJson(response, 202, await service.rollbackMember({
            member: typeof body.member === "string" ? body.member : ""
          }));
          return;
        }
        if (path25 === "/upgrade" || path25 === "/test-upgrade") {
          const body = await readJson2(request);
          const request_ = {
            member: typeof body.member === "string" ? body.member : void 0,
            package: typeof body.package === "string" ? body.package : void 0,
            // Upgrade downloads default to the external proxy; the panel can
            // pick a different member or ask for a direct download.
            ...typeof body.proxyMember === "string" && body.proxyMember.trim() !== "" ? { proxyMember: body.proxyMember.trim() } : {},
            ...body.direct === true ? { direct: true } : {}
          };
          const test = path25 === "/test-upgrade" || body.test === true;
          writeJson(response, 202, test ? await service.testUpgradeMember(request_) : await service.upgradeMember(request_));
          return;
        }
        if (path25 === "/schedule") {
          if (scheduler === null) {
            writeJson(response, 503, { ok: false, error: { code: "unavailable", message: "\u5B9A\u65F6\u4EFB\u52A1\u8FD8\u6CA1\u6709\u542F\u52A8\u3002" } });
            return;
          }
          const body = await readJson2(request);
          const member = typeof body.member === "string" ? body.member.trim() : "";
          const patch = member === "" ? {
            build: body.build !== null && typeof body.build === "object" ? {
              ...typeof body.build.enabled === "boolean" ? { enabled: body.build.enabled } : {},
              ...typeof body.build.time === "string" ? { time: body.build.time } : {}
            } : void 0
          } : {
            member,
            upgrade: body.upgrade !== null && typeof body.upgrade === "object" ? {
              ...typeof body.upgrade.enabled === "boolean" ? { enabled: body.upgrade.enabled } : {},
              ...typeof body.upgrade.time === "string" ? { time: body.upgrade.time } : {}
            } : void 0
          };
          writeJson(response, 200, { ok: true, schedule: await scheduler.update(patch) });
          return;
        }
        if (path25 === "/build") {
          const body = await readJson2(request);
          const job = await service.startBuild({
            source: typeof body.source === "string" ? body.source : void 0,
            ref: typeof body.ref === "string" ? body.ref : void 0,
            targets: Array.isArray(body.targets) ? body.targets.filter((value) => typeof value === "string") : void 0,
            planOnly: body.planOnly === true,
            version: typeof body.version === "string" ? body.version : void 0,
            member: typeof body.member === "string" ? body.member : void 0,
            proxy: typeof body.proxy === "string" ? body.proxy : void 0,
            proxyMember: typeof body.proxyMember === "string" ? body.proxyMember : void 0
          });
          writeJson(response, 202, { ok: true, job });
          return;
        }
        const resume = /^\/build\/([^/]+)\/resume$/u.exec(path25);
        if (resume !== null) {
          writeJson(response, 202, { ok: true, job: await service.resumeBuild(resume[1]) });
          return;
        }
        const match = /^\/build\/([^/]+)\/learn$/u.exec(path25);
        if (match !== null) {
          writeJson(response, 200, { ok: true, job: await service.learn(match[1]) });
          return;
        }
        writeJson(response, 404, { ok: false, error: { code: "not_found", message: "Unknown mesh endpoint." } });
      } catch (error) {
        writeJson(response, 400, {
          ok: false,
          error: {
            code: "request_failed",
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
  }), "mesh local api");
}

// src/lib/scheduler.mjs
import { mkdir as mkdir12, readFile as readFile14, writeFile as writeFile12 } from "node:fs/promises";
import path21 from "node:path";
var TICK_TOLERANCE_MS = 9e4;
var DUPLICATE_WINDOW_MS = 10 * 6e4;
var Scheduler = class {
  /**
   * @param {object} options scheduler input.
   * @param {{ scheduledBuild: () => Promise<object>, scheduledUpgradeMember: (memberId: string) => Promise<object> }} options.service mesh service.
   * @param {string} options.file `schedule.json` path.
   * @param {() => Promise<string[]>} [options.members] current member id provider.
   * @param {(line: string) => void} [options.log] logger.
   * @param {() => number} [options.now] clock (tests).
   * @param {typeof setTimeout} [options.setTimeout] timer factory (tests).
   * @param {typeof clearTimeout} [options.clearTimeout] timer canceller (tests).
   * @param {boolean} [options.autoStart] arm on construction; default true.
   */
  constructor(options) {
    this.service = options.service;
    this.file = options.file;
    this.memberIdProvider = typeof options.members === "function" ? options.members : null;
    this.log = typeof options.log === "function" ? options.log : () => {
    };
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.setTimer = options.setTimeout ?? setTimeout;
    this.clearTimer = options.clearTimeout ?? clearTimeout;
    this.schedule = normalizeSchedules({});
    this.upgrades = /* @__PURE__ */ new Map();
    this.last = { build: null, upgrades: {} };
    this.runningUpgrades = /* @__PURE__ */ new Set();
    this.runningBuild = false;
    this.memberIds = [];
    this.timer = null;
    this.disposed = false;
    this.loading = null;
    if (options.autoStart !== false) void this.start();
  }
  /**
   * Read the persisted schedule, discover members, and arm the timer.
   * @returns {Promise<void>} when armed.
   */
  async start() {
    await this.#load();
    await this.#refreshMembers();
    this.#arm();
  }
  /**
   * Merge one client update and re-arm immediately.
   *
   * Either the build clock (`{build}`) or one member's auto-upgrade
   * (`{member, upgrade}`) is updated per call.
   * @param {{build?: {enabled?: boolean, time?: string}, member?: string, upgrade?: {enabled?: boolean, time?: string}}} patch schedule patch.
   * @returns {Promise<object>} new status (build or the member's entry).
   */
  async update(patch) {
    const memberId = typeof patch?.member === "string" ? patch.member.trim() : "";
    if (memberId !== "") {
      const entry = normalizeUpgradeSchedule({
        ...upgradeEntryFor(this.schedule, memberId),
        ...patch?.upgrade ?? {}
      });
      this.upgrades.set(memberId, entry);
      if (!this.memberIds.includes(memberId)) this.memberIds.push(memberId);
    } else if (patch?.build !== void 0) {
      this.schedule.build = normalizeBuildSchedule({ ...this.schedule.build, ...patch.build ?? {} });
    }
    this.schedule = {
      ...this.schedule,
      upgrades: Object.fromEntries(this.upgrades)
    };
    await this.#save();
    this.#arm();
    this.log(`schedule saved: build ${this.schedule.build.time} ${this.schedule.build.enabled ? "on" : "off"}${memberId === "" ? "" : `, upgrade ${memberId} ${this.upgrades.get(memberId)?.time} ${this.upgrades.get(memberId)?.enabled ? "on" : "off"}`}`);
    return this.status(memberId === "" ? void 0 : memberId);
  }
  /**
   * The panel's read model.
   * @param {string} [memberId] when set, include that member's auto-upgrade.
   * @returns {object} status.
   */
  status(memberId) {
    const at = new Date(this.now());
    const result = {
      ok: true,
      build: this.#statusEntry(this.schedule.build, "build", void 0, at)
    };
    if (typeof memberId === "string" && memberId !== "") {
      result.upgrade = this.#statusEntry(upgradeEntryFor(this.schedule, memberId), "upgrade", memberId, at);
    }
    return result;
  }
  /** Stop the timer. */
  dispose() {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  /** Build one status row with next occurrence and last outcome. */
  #statusEntry(entry, kind, memberId, at) {
    const last = kind === "build" ? this.last.build : this.last.upgrades[memberId] ?? null;
    return {
      enabled: entry.enabled,
      time: entry.time,
      next: entry.enabled ? nextRunAt(at, entry.time).toISOString() : null,
      last,
      running: kind === "build" ? this.runningBuild : this.runningUpgrades.has(memberId),
      ...memberId === void 0 ? {} : { member: memberId }
    };
  }
  /** Read the schedule file once. */
  async #load() {
    if (this.loading !== null) return this.loading;
    this.loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile14(this.file, "utf8"));
        const normalized = normalizeSchedules(parsed);
        this.schedule = normalized;
        this.upgrades = new Map(Object.entries(normalized.upgrades));
        if (parsed?.last !== null && typeof parsed?.last === "object") {
          this.last = {
            build: typeof parsed.last.build === "object" ? parsed.last.build : null,
            upgrades: parsed.last.upgrades !== null && typeof parsed.last.upgrades === "object" ? parsed.last.upgrades : {}
          };
        }
      } catch {
      }
    })();
    return this.loading;
  }
  /** Persist the current settings and last outcomes. */
  async #save() {
    try {
      await mkdir12(path21.dirname(this.file), { recursive: true });
      await writeFile12(this.file, `${JSON.stringify({
        format: 2,
        build: this.schedule.build,
        upgrade: this.schedule.upgrade,
        upgrades: Object.fromEntries(this.upgrades),
        last: this.last
      }, null, 2)}
`, "utf8");
    } catch (error) {
      this.log(`cannot save schedule: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /** Ask the service who exists now; a failure keeps the previous list. */
  async #refreshMembers() {
    if (this.memberIdProvider === null) return;
    try {
      const ids = await this.memberIdProvider();
      const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id !== ""))];
      if (unique.length > 0) this.memberIds = unique;
    } catch {
    }
  }
  /** One timer for the nearest enabled occurrence. */
  #arm() {
    if (this.disposed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const at = new Date(this.now());
    const candidates = [];
    if (this.schedule.build.enabled) {
      candidates.push({ kind: "build", memberId: void 0, at: nextRunAt(at, this.schedule.build.time) });
    }
    const ids = [.../* @__PURE__ */ new Set([...this.memberIds, ...this.upgrades.keys()])];
    for (const memberId of ids) {
      const entry = upgradeEntryFor(this.schedule, memberId);
      if (!entry.enabled) continue;
      candidates.push({ kind: "upgrade", memberId, at: nextRunAt(at, entry.time) });
    }
    if (candidates.length === 0) return;
    candidates.sort((left, right) => left.at.getTime() - right.at.getTime());
    const next = candidates[0];
    const delay = Math.max(0, next.at.getTime() - at.getTime());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.#tick();
    }, delay);
    if (typeof this.timer?.unref === "function") this.timer.unref();
    this.log(`next ${next.kind}${next.memberId === void 0 ? "" : ` ${next.memberId}`} at ${next.at.toISOString()}`);
  }
  /** Run every occurrence due in this tick, then re-arm. */
  async #tick() {
    if (this.disposed) return;
    await this.#refreshMembers();
    const at = new Date(this.now());
    try {
      if (this.schedule.build.enabled && this.#isDue(this.schedule.build.time, at)) {
        if (!this.#recentlyRan(this.last.build)) await this.#runBuild();
      }
      for (const memberId of [.../* @__PURE__ */ new Set([...this.memberIds, ...this.upgrades.keys()])]) {
        const entry = upgradeEntryFor(this.schedule, memberId);
        if (!entry.enabled || !this.#isDue(entry.time, at)) continue;
        if (this.runningUpgrades.has(memberId)) continue;
        if (this.#recentlyRan(this.last.upgrades[memberId])) continue;
        await this.#runUpgrade(memberId);
      }
    } finally {
      this.#arm();
    }
  }
  /** Whether a daily clock occurrence is within the tick window. */
  #isDue(time, at) {
    const base = new Date(at.getTime() - 24 * 60 * 6e4);
    const due = nextRunAt(base, time);
    return Math.abs(due.getTime() - at.getTime()) <= TICK_TOLERANCE_MS;
  }
  /** Whether this kind already ran within the duplicate window. */
  #recentlyRan(last) {
    const at = last?.at;
    return typeof at === "string" && Math.abs(this.now() - Date.parse(at)) < DUPLICATE_WINDOW_MS;
  }
  /** Run the build hook and record the outcome. */
  async #runBuild() {
    if (this.runningBuild) return;
    this.runningBuild = true;
    const at = new Date(this.now()).toISOString();
    try {
      this.log(`build tick at ${at}`);
      const result = await this.service.scheduledBuild();
      this.last.build = { at, ...result !== null && typeof result === "object" ? result : { status: "unknown" } };
      await this.#save();
      this.log(`build: ${String(this.last.build.status ?? "unknown")}${this.last.build.reason ? ` (${String(this.last.build.reason)})` : ""}`);
    } catch (error) {
      this.last.build = { at, status: "failed", reason: error instanceof Error ? error.message : String(error) };
      await this.#save();
      this.log(`build failed: ${String(this.last.build.reason)}`);
    } finally {
      this.runningBuild = false;
    }
  }
  /** Run one member's upgrade hook and record the outcome. */
  async #runUpgrade(memberId) {
    if (this.runningUpgrades.has(memberId)) return;
    this.runningUpgrades.add(memberId);
    const at = new Date(this.now()).toISOString();
    try {
      this.log(`upgrade ${memberId} tick at ${at}`);
      const result = await this.service.scheduledUpgradeMember(memberId);
      this.last.upgrades[memberId] = { at, ...result !== null && typeof result === "object" ? result : { status: "unknown" } };
      await this.#save();
      this.log(`upgrade ${memberId}: ${String(this.last.upgrades[memberId].status ?? "unknown")}${this.last.upgrades[memberId].reason ? ` (${String(this.last.upgrades[memberId].reason)})` : ""}`);
    } catch (error) {
      this.last.upgrades[memberId] = { at, status: "failed", reason: error instanceof Error ? error.message : String(error) };
      await this.#save();
      this.log(`upgrade ${memberId} failed: ${String(this.last.upgrades[memberId].reason)}`);
    } finally {
      this.runningUpgrades.delete(memberId);
    }
  }
};

// src/lib/wireguard-api.mjs
import { request as httpRequest } from "node:http";
var API_PREFIX2 = "/api/dsh-wireguard";
function proxy(request, response) {
  const port = Number(process.env.DSH_WIREGUARD_CONTROL_PORT ?? "51821");
  return new Promise((resolve) => {
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: Number.isSafeInteger(port) && port > 0 ? port : 51821,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${String(port)}` }
    }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
      answer.once("end", resolve);
    });
    upstream.once("error", () => {
      if (!response.headersSent) {
        const body = JSON.stringify({
          ok: false,
          error: {
            code: "control_panel_unavailable",
            message: "The standalone WireGuard control service is not reachable on 51821."
          }
        });
        response.writeHead(503, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store"
        });
        response.end(body);
      }
      resolve();
    });
    request.pipe(upstream);
  });
}
function registerWireGuardApi(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX2,
    handler: proxy
  }), "mesh wireguard api");
}

// src/lib/member-tasks.mjs
import { randomUUID } from "node:crypto";
import { mkdir as mkdir13, readFile as readFile15, readdir as readdir8, rename as rename8, writeFile as writeFile13 } from "node:fs/promises";
import { existsSync as existsSync12, readFileSync as readFileSync5 } from "node:fs";
import path22 from "node:path";
var DEFAULT_INTEROP_PORT = 8765;
var WAIT_TIMEOUT_MS = 6e4;
var MAX_ATTEMPTS = 30;
var LOST_CONVERSATION = /conversation not found|unknown SDK session|session "?[\w-]+"? already exists|SDK session is already open or opening|session agent was disposed/iu;
var EMPTY_TURN = "\u76EE\u6807\u7684 DSH \u5728\u4EFB\u52A1\u6267\u884C\u671F\u95F4\u91CD\u542F\u4E86\uFF1A\u5BF9\u8BDD\u6CA1\u6709\u4EA7\u751F\u4EFB\u4F55\u8F93\u51FA\uFF0C\u8FD9\u4E00\u8F6E\u5DF2\u4E2D\u65AD";
var EMPTY_WAIT_RETRIES = 3;
function envFile(file) {
  const values = {};
  if (!existsSync12(file)) return values;
  for (const raw of readFileSync5(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}
function truncate(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\u2026` : value;
}
var MemberTaskService = class {
  /**
   * @param {{ctx: any, service: any, dataDir: string, log?: (line:string)=>void}} options options.
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.service = options.service;
    this.dataDir = options.dataDir;
    this.logLine = options.log ?? (() => {
    });
    this.taskRoot = path22.join(this.dataDir, "member-tasks");
    this.tasks = /* @__PURE__ */ new Map();
    this.monitors = /* @__PURE__ */ new Map();
    this.controllers = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Map();
    this.identity = null;
    this.loaded = false;
    this.disposed = false;
  }
  async dispose() {
    this.disposed = true;
    for (const controller of this.controllers.values()) {
      try {
        controller.abort(new Error("the plugin stopped"));
      } catch {
      }
    }
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.status === "starting") {
        task.status = "interrupted";
        task.error = "the plugin stopped before the member conversation completed";
        await this.#save(task).catch(() => {
        });
      }
      this.#notifyWaiters(task);
    }
  }
  async #ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir13(this.taskRoot, { recursive: true });
    let files = [];
    try {
      files = await readdir8(this.taskRoot);
    } catch {
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const task = JSON.parse(await readFile15(path22.join(this.taskRoot, file), "utf8"));
        if (task?.id === void 0) continue;
        if (task.status === "running" || task.status === "starting") {
          task.status = "interrupted";
          task.error = "the plugin restarted before the member conversation completed";
          await this.#save(task);
        }
        task.replies = Array.isArray(task.replies) ? task.replies : [];
        task.replySeq = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0;
        task.deliveredSeq = Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0;
        this.tasks.set(task.id, task);
      } catch {
      }
    }
  }
  async #save(task) {
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const file = path22.join(this.taskRoot, `${task.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await mkdir13(this.taskRoot, { recursive: true });
    await writeFile13(temporary, `${JSON.stringify(task, null, 2)}
`, "utf8");
    await rename8(temporary, file);
  }
  async #log(task, line) {
    const text = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}
`;
    try {
      await writeFile13(path22.join(this.taskRoot, `${task.id}.log`), text, { encoding: "utf8", flag: "a" });
    } catch {
    }
    try {
      this.logLine(`member-task ${task.id}: ${line}`);
    } catch {
    }
  }
  #port() {
    const configured = this.service.config?.interopPort;
    if (Number.isSafeInteger(configured) && configured > 0 && configured < 65536) return configured;
    return DEFAULT_INTEROP_PORT;
  }
  #token() {
    const configured = this.service.config?.interopToken;
    if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
    if (process.env.DSH_INTEROP_TOKEN) return process.env.DSH_INTEROP_TOKEN;
    if (this.service.config?.interopUseGatePassword !== false) {
      if (process.env.DSH_GATE_PASSWORD) return process.env.DSH_GATE_PASSWORD;
      const candidates = [
        path22.join(this.service.repositoryRoot, "..", "config", "gate.env"),
        path22.join(this.service.repositoryRoot, "config", "gate.env"),
        path22.join(this.service.dataDir, "..", "..", "config", "gate.env")
      ];
      for (const file of candidates) {
        const password = envFile(file).DSH_GATE_PASSWORD;
        if (typeof password === "string" && password !== "") return password;
      }
    }
    throw new Error("no interop token: set interopToken, DSH_INTEROP_TOKEN, or DSH_GATE_PASSWORD");
  }
  /**
   * The interop base URL of one member address.
   * @param {string} address member VPN address or http(s) URL.
   * @returns {string} base URL without trailing slash.
   */
  #baseUrl(address) {
    const raw = String(address ?? "");
    if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
    const host = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
    return `http://${host}:${String(this.#port())}`;
  }
  async #resolveMember(input) {
    const raw = String(input ?? "").trim();
    if (raw === "") throw new Error("member is required");
    if (/^https?:\/\//i.test(raw)) {
      return { name: raw, ip: raw, baseUrl: raw.replace(/\/+$/, "") };
    }
    const snapshot = await this.service.members();
    this.identity = this.identity ?? {
      id: String(snapshot.local?.id ?? "local"),
      name: String(snapshot.local?.name ?? snapshot.local?.id ?? "local"),
      ip: String(snapshot.local?.ip ?? "")
    };
    const all = [snapshot.local, ...Array.isArray(snapshot.members) ? snapshot.members : []].filter(Boolean);
    const match = all.find((member2) => String(member2.id) === raw || String(member2.name) === raw || String(member2.ip) === raw);
    const member = match ?? { id: raw, name: raw, ip: raw };
    let host = String(member.ip ?? member.id ?? raw);
    if (/^https?:\/\//i.test(host)) return { name: member.name ?? raw, ip: host, baseUrl: host.replace(/\/+$/, "") };
    return {
      name: member.name ?? member.id ?? raw,
      ip: String(member.ip ?? member.id ?? raw),
      baseUrl: this.#baseUrl(host)
    };
  }
  async #request(baseUrl, method, endpoint, body, timeoutMs = 3e4, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.max(1e3, timeoutMs));
    timer.unref?.();
    const forwardAbort = () => {
      controller.abort(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal !== void 0) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    let response;
    try {
      response = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token()}`,
          ...body === void 0 ? {} : { "content-type": "application/json" }
        },
        ...body === void 0 ? {} : { body: JSON.stringify(body) },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
    }
    if (!response.ok) {
      const message = parsed?.error?.message ?? text ?? `HTTP ${String(response.status)}`;
      throw new Error(`${String(response.status)} ${message}`);
    }
    if (parsed === null) throw new Error("member interop returned a non-JSON response");
    return parsed;
  }
  /**
   * Wait out a member runtime that is still booting.
   *
   * A member's interop answers 503 while its SDK child starts, which is exactly
   * the window right after that machine's DSH restarted. A tool call made in
   * that window should wait for it instead of failing outright.
   * @param {() => Promise<any>} attempt one request.
   * @param {number} [budgetMs] how long to keep waiting.
   * @returns {Promise<any>} the request result.
   */
  async #waitForRuntime(attempt, budgetMs = 9e4, signal) {
    const deadline = Date.now() + budgetMs;
    for (; ; ) {
      signal?.throwIfAborted();
      try {
        return await attempt();
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        const starting = /SDK runtime is not ready|sdk_unavailable|SDK runtime is still starting/iu.test(message);
        if (!starting || Date.now() >= deadline) throw error;
        await new Promise((resolve) => {
          const timer = setTimeout(done, 2e3);
          timer.unref?.();
          function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
          }
          if (signal !== void 0) {
            if (signal.aborted) done();
            else signal.addEventListener("abort", done, { once: true });
          }
        });
      }
    }
  }
  async start({ member, prompt, cwd, workspace, agent, notify = true, signal }) {
    await this.#ensureLoaded();
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("prompt is required");
    if (agent === void 0 || agent === null) throw new Error("delegation must be called from a DSH conversation");
    const target = await this.#resolveMember(member);
    const payload = {
      prompt,
      // The member's panel lists these; without a title it would show a UUID.
      title: truncate(prompt, 80),
      initiator: { ...this.identity ?? { id: "local" }, source: "call_member" },
      ...typeof workspace === "string" && workspace.trim() !== "" ? { workspace: workspace.trim() } : {},
      ...typeof cwd === "string" && cwd !== "" ? { cwd } : {}
    };
    const created = await this.#waitForRuntime(
      () => this.#request(target.baseUrl, "POST", "/v1/conversations", payload, 6e4, signal),
      9e4,
      signal
    );
    const conversation = created.conversation;
    if (conversation === void 0 || typeof conversation.id !== "string") throw new Error("member interop did not return a conversation id");
    const task = {
      id: `member-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      member: target.name,
      memberIp: target.ip,
      baseUrl: target.baseUrl,
      conversationId: conversation.id,
      prompt: truncate(prompt, 2e3),
      status: "running",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastText: "",
      error: null,
      interrupted: false,
      attempts: 0,
      turns: 0,
      /** Replies already accepted from the member, oldest first. */
      replies: [],
      /** Newest reply sequence number seen on the member. */
      replySeq: 0,
      /** Newest reply seq a `wait_member` call already returned to the model. */
      deliveredSeq: 0,
      notify,
      notified: false,
      notifiedAt: null,
      notifyError: null,
      originAgentId: String(agent.id ?? ""),
      originSessionId: String(agent.session?.id ?? "")
    };
    this.controllers.set(task.id, new AbortController());
    this.tasks.set(task.id, task);
    await this.#save(task);
    await this.#log(task, `created ${conversation.id} on ${target.baseUrl}`);
    const monitor = this.#monitor(task);
    this.monitors.set(task.id, monitor);
    void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {
    });
    return task;
  }
  /**
   * Wait for the next news about one task, up to a bounded timeout.
   *
   * "News" is either a finished-turn reply the model has not seen yet, or the
   * task reaching a terminal state. The monitor keeps running in the background,
   * so a timeout only ends this caller's wait; the same taskId can be waited
   * again, and replies that arrived meanwhile are not lost.
   *
   * `signal` is the tool call's own cancellation. It ends the park at once
   * rather than at the next wake, so stopping the conversation does not leave
   * the call hanging until its deadline; the thrown reason is the signal's own
   * reason, which is what makes DSH report the call as cancelled.
   * @param {string} taskId task id returned by call_member.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] wait options.
   * @returns {Promise<{done: boolean, timedOut: boolean, task: object, replies: object[], state: string}>} outcome.
   */
  async wait(taskId, options = {}) {
    await this.#ensureLoaded();
    const id = String(taskId ?? "");
    if (id === "") throw new Error("taskId is required");
    const timeoutMs = Math.max(1e3, Math.min(Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : 3e4, 3e5));
    const signal = options.signal;
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      signal?.throwIfAborted();
      const task = this.tasks.get(id);
      if (task === void 0) throw new Error(`member task not found: ${id}`);
      const replies = this.#pendingReplies(task);
      const terminal = task.status === "completed" || task.status === "failed" || task.status === "interrupted";
      if (replies.length > 0) {
        task.deliveredSeq = replies[replies.length - 1].seq;
        await this.#save(task).catch(() => {
        });
        return {
          done: terminal,
          timedOut: false,
          task,
          replies,
          state: terminal ? task.status === "completed" ? "done" : "failed" : "progress"
        };
      }
      if (terminal) {
        return { done: true, timedOut: false, task, replies: [], state: task.status === "completed" ? "done" : "failed" };
      }
      const left = deadline - Date.now();
      if (left <= 0) return { done: false, timedOut: true, task, replies: [], state: "running" };
      await this.#waitForWake(task, left, signal);
    }
  }
  /** Replies this task received but no `wait` call has returned yet. */
  #pendingReplies(task) {
    const delivered = Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0;
    const replies = Array.isArray(task.replies) ? task.replies : [];
    return replies.filter((reply) => Number.isSafeInteger(reply?.seq) && reply.seq > delivered);
  }
  /**
   * Park until this task changes, the budget runs out, or the call is cancelled.
   *
   * A promise per waiter (rather than a poll loop) is what makes a finished
   * turn reach the model immediately, without a half-second of latency. The
   * abort listener is the same waiter, so a cancelled tool call stops parking
   * right away instead of waiting for a reply or the deadline.
   * @param {object} task member task.
   * @param {number} ms maximum wait.
   * @param {AbortSignal} [signal] cancellation of the waiting tool call.
   * @returns {Promise<void>} resolves on a wake, on the deadline, or on abort.
   */
  #waitForWake(task, ms, signal) {
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        this.waiters.get(task.id)?.delete(wake);
        resolve();
      };
      timer = setTimeout(wake, Math.max(0, ms));
      timer.unref?.();
      let parked = this.waiters.get(task.id);
      if (parked === void 0) {
        parked = /* @__PURE__ */ new Set();
        this.waiters.set(task.id, parked);
      }
      parked.add(wake);
      if (signal !== void 0) {
        if (signal.aborted) wake();
        else signal.addEventListener("abort", wake, { once: true });
      }
    });
  }
  /** Wake every `wait_member` call parked on this task. */
  #notifyWaiters(task) {
    const parked = this.waiters.get(task.id);
    if (parked === void 0) return;
    this.waiters.delete(task.id);
    for (const waiter of [...parked]) {
      try {
        waiter();
      } catch {
      }
    }
  }
  async send(taskId, content, signal) {
    await this.#ensureLoaded();
    const task = this.tasks.get(String(taskId));
    if (task === void 0) throw new Error("member task not found");
    if (typeof content !== "string" || content.trim() === "") throw new Error("content is required");
    const result = await this.#waitForRuntime(
      () => this.#request(task.baseUrl, "POST", `/v1/conversations/${encodeURIComponent(task.conversationId)}/messages`, { content }, 3e4, signal),
      9e4,
      signal
    );
    task.status = "running";
    task.error = null;
    task.interrupted = false;
    task.attempts = 0;
    task.emptyWaits = 0;
    task.notified = false;
    task.notifiedAt = null;
    task.notifyError = null;
    task.notify = false;
    await this.#save(task);
    await this.#log(task, `message queued: ${result?.receipt?.messageId ?? "unknown"}`);
    if (!this.monitors.has(task.id)) {
      const monitor = this.#monitor(task);
      this.monitors.set(task.id, monitor);
      void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {
      });
    }
    return task;
  }
  /**
   * Send a message typed in the panel to one or more members.
   *
   * A member whose conversation is still running gets the text as a follow-up;
   * everyone else gets a fresh conversation. No task is created and nothing is
   * notified back: the panel reads conversations straight from each member, so
   * the answer shows up in the group chat on the next refresh.
   * @param {{text: string, members?: string[]}} input text and target ids/ips.
   * @returns {Promise<{ok: boolean, sent: object[], errors: object[]}>} outcome.
   */
  async sendTo({ text, members = [] }) {
    const content = String(text ?? "").trim();
    if (content === "") throw new Error("text is required");
    const snapshot = await this.service.members();
    this.identity = this.identity ?? {
      id: String(snapshot.local?.id ?? "local"),
      name: String(snapshot.local?.name ?? snapshot.local?.id ?? "local"),
      ip: String(snapshot.local?.ip ?? "")
    };
    const others = [snapshot.local, ...Array.isArray(snapshot.members) ? snapshot.members : []].filter(Boolean).filter((member) => member.kind !== "self" && member.self !== true);
    const wanted = (Array.isArray(members) ? members : []).map((item) => String(item).trim()).filter((item) => item !== "");
    const targets = [];
    if (wanted.length === 0) {
      targets.push(...others);
    } else {
      for (const item of wanted) {
        const match = others.find((member) => [String(member.id), String(member.ip), String(member.name)].includes(item));
        if (match !== void 0) {
          if (!targets.includes(match)) targets.push(match);
          continue;
        }
        const resolved = await this.#resolveMember(item).catch(() => null);
        if (resolved !== null && !targets.some((member) => member.ip === resolved.ip)) targets.push(resolved);
      }
    }
    if (targets.length === 0) throw new Error("no member to send to");
    const sent = [];
    const errors = [];
    await Promise.all(targets.map(async (member) => {
      const name = String(member.name ?? member.id ?? member.ip ?? "");
      const ip = String(member.ip ?? "");
      const label = ip === "" ? name : `${name} (${ip})`;
      try {
        const baseUrl = this.#baseUrl(ip === "" ? name : ip);
        const listed = await this.#request(baseUrl, "GET", "/v1/conversations", void 0, 8e3).catch(() => null);
        const live = (Array.isArray(listed?.conversations) ? listed.conversations : []).find((row) => row.status === "running" && this.#isOwnConversation(row));
        if (live !== void 0) {
          await this.#request(baseUrl, "POST", `/v1/conversations/${encodeURIComponent(live.id)}/messages`, { content }, 3e4);
          sent.push({ member: name, ip, conversationId: String(live.id), reused: true });
          return;
        }
        const created = await this.#request(baseUrl, "POST", "/v1/conversations", {
          prompt: content,
          // The panel clamps the bubble, so the whole text is the title: a
          // truncated one would never be recoverable through 详细.
          title: content.length > 2e3 ? `${content.slice(0, 2e3)}\u2026` : content,
          initiator: { ...this.identity, source: "panel" }
        }, 6e4);
        const conversation = created?.conversation ?? {};
        sent.push({ member: name, ip, conversationId: String(conversation.id ?? ""), reused: false });
      } catch (error) {
        errors.push({ member: label, ip, error: error instanceof Error ? error.message : String(error) });
      }
    }));
    return { ok: true, sent, errors };
  }
  /**
   * True when a member's conversation was started from this machine.
   * @param {object} row conversation summary.
   * @returns {boolean} whether this host initiated it.
   */
  #isOwnConversation(row) {
    const initiator = row?.initiator ?? null;
    if (initiator === null || this.identity === null) return false;
    if (initiator.id !== void 0 && String(initiator.id) === String(this.identity.id)) return true;
    return initiator.ip !== void 0 && String(initiator.ip) !== "" && String(initiator.ip) === String(this.identity.ip);
  }
  async #monitor(task) {
    const signal = this.controllers.get(task.id)?.signal;
    while (!this.disposed && (task.status === "running" || task.status === "starting")) {
      if (signal?.aborted) break;
      task.attempts += 1;
      try {
        const result = await this.#request(
          task.baseUrl,
          "POST",
          `/v1/conversations/${encodeURIComponent(task.conversationId)}/wait`,
          { timeoutMs: WAIT_TIMEOUT_MS, since: Number.isSafeInteger(task.replySeq) ? task.replySeq : 0 },
          WAIT_TIMEOUT_MS + 1e4,
          signal
        );
        task.attempts = 0;
        if (result.timedOut === true) {
          task.status = "running";
          await this.#save(task);
          continue;
        }
        if (this.disposed) break;
        const conversation = result.conversation ?? {};
        if (conversation.error) task.error = String(conversation.error);
        const status = String(conversation.status ?? "");
        if (status === "interrupted" || status === "unavailable") {
          task.status = "failed";
          task.interrupted = true;
          task.error = String(conversation.error ?? EMPTY_TURN);
          break;
        }
        const state = typeof result.state === "string" ? result.state : "";
        if (state === "progress" || state === "done") {
          await this.#acceptReplies(task, result, { notify: state === "progress" });
          if (Number.isSafeInteger(result.turn)) task.turns = result.turn;
          if (state === "progress") {
            task.emptyWaits = 0;
            task.status = "running";
            await this.#save(task);
            continue;
          }
          if (task.turns === 0 && String(task.lastText ?? "") === "") {
            task.emptyWaits = (task.emptyWaits ?? 0) + 1;
            if (task.emptyWaits < EMPTY_WAIT_RETRIES) {
              await new Promise((resolve) => setTimeout(resolve, 1e3));
              continue;
            }
            task.status = "failed";
            task.interrupted = true;
            task.error = EMPTY_TURN;
            break;
          }
          task.emptyWaits = 0;
          task.status = conversation.error ? "failed" : "completed";
          break;
        }
        task.lastText = typeof conversation.lastText === "string" ? conversation.lastText : "";
        if (status === "idle" && !this.#turnAdvanced(task, conversation) && String(task.lastText ?? "") === "") {
          task.emptyWaits = (task.emptyWaits ?? 0) + 1;
          if (task.emptyWaits < EMPTY_WAIT_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, 1e3));
            continue;
          }
          task.status = "failed";
          task.interrupted = true;
          task.error = EMPTY_TURN;
          break;
        }
        task.emptyWaits = 0;
        if (Number.isSafeInteger(conversation.turns)) task.turns = conversation.turns;
        task.status = conversation.status === "idle" ? conversation.error ? "failed" : "completed" : "running";
        if (task.status === "completed" || task.status === "failed") break;
      } catch (error) {
        if (signal?.aborted || task.status === "interrupted") break;
        task.error = error instanceof Error ? error.message : String(error);
        await this.#log(task, `wait failed: ${task.error}`);
        if (LOST_CONVERSATION.test(task.error)) {
          task.status = "failed";
          task.interrupted = true;
          break;
        }
        if (task.attempts >= MAX_ATTEMPTS) {
          task.status = "failed";
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(2e3 * task.attempts, 15e3)));
      }
    }
    this.controllers.delete(task.id);
    if (this.disposed && task.status === "running") {
      task.status = "interrupted";
      task.error = "the plugin stopped before the member conversation completed";
    }
    if (task.status === "completed" || task.status === "failed") {
      await this.#save(task);
      await this.#log(task, `${task.status}: ${truncate(task.lastText || task.error || "", 500)}`);
      if (task.notify) await this.#notify(task);
    }
    this.#notifyWaiters(task);
    return task;
  }
  /**
   * Store the replies a wait response brought and wake parked `wait_member` calls.
   *
   * Replies are idempotent on their `seq`, so a response that repeats the last
   * reply (a `done` that follows a `progress` for the same turn) cannot make the
   * model read the same answer twice.
   * @param {object} task the tracked task.
   * @param {object} result wait response from the member.
   * @param {{notify?: boolean}} [options] `notify: false` when the caller will
   *   wake waiters itself after updating the task status.
   * @returns {Promise<boolean>} whether anything new arrived.
   */
  async #acceptReplies(task, result, options = {}) {
    const incoming = Array.isArray(result.replies) && result.replies.length > 0 ? result.replies : typeof result.text === "string" && result.text !== "" && Number.isSafeInteger(result.seq) ? [{ seq: result.seq, turn: result.turn, text: result.text }] : [];
    const seen = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0;
    let added = false;
    for (const reply of incoming) {
      if (!Number.isSafeInteger(reply?.seq) || reply.seq <= seen) continue;
      if (typeof reply.text !== "string" || reply.text.trim() === "") continue;
      task.replies = Array.isArray(task.replies) ? task.replies : [];
      task.replies.push({
        seq: reply.seq,
        turn: Number.isSafeInteger(reply.turn) ? reply.turn : null,
        text: truncate(reply.text, 2e4),
        at: typeof reply.at === "string" ? reply.at : (/* @__PURE__ */ new Date()).toISOString()
      });
      if (task.replies.length > 30) task.replies.splice(0, task.replies.length - 30);
      task.replySeq = reply.seq;
      task.lastText = truncate(reply.text, 2e4);
      added = true;
    }
    if (!added) return false;
    await this.#save(task);
    await this.#log(task, `reply ${String(task.replySeq)}: ${truncate(task.lastText, 300)}`);
    if (options.notify !== false) this.#notifyWaiters(task);
    return true;
  }
  /**
   * True when a wait result proves a turn finished on the member.
   *
   * Members that report a turn counter let this be exact: the count has to grow.
   * An older member returns no counter, so its answer text is the only evidence.
   * @param {object} task the tracked task.
   * @param {object} conversation the member's conversation summary.
   * @returns {boolean} whether the conversation moved past the previous turn.
   */
  #turnAdvanced(task, conversation) {
    if (!Number.isSafeInteger(conversation.turns)) return String(conversation.lastText ?? "") !== "";
    return conversation.turns > (Number.isSafeInteger(task.turns) ? task.turns : 0);
  }
  async #notify(task) {
    const agents = typeof this.ctx.get === "function" ? this.ctx.get("agents") : this.ctx.agents;
    const agent = agents?.get?.(task.originAgentId);
    if (agent === void 0 || agent === null) {
      task.notifyError = "the originating conversation is no longer live";
      await this.#save(task);
      await this.#log(task, "notification skipped: origin agent unavailable");
      return;
    }
    const text = task.status === "completed" ? [
      `[\u6210\u5458\u4EFB\u52A1\u5B8C\u6210] ${task.member} (${task.memberIp}) \u7684\u5BF9\u8BDD ${task.conversationId} \u5DF2\u5B8C\u6210\u3002`,
      `\u4EFB\u52A1\uFF1A${truncate(task.prompt, 300)}`,
      "\u7ED3\u679C\uFF1A",
      truncate(task.lastText || "(\u6210\u5458\u6CA1\u6709\u8FD4\u56DE\u6587\u672C\u7ED3\u679C)", 8e3),
      "",
      `taskId: ${task.id}`
    ].join("\n") : [
      `[\u6210\u5458\u4EFB\u52A1\u5931\u8D25] ${task.member} (${task.memberIp}) \u7684\u5BF9\u8BDD ${task.conversationId} \u5931\u8D25\u3002`,
      `\u4EFB\u52A1\uFF1A${truncate(task.prompt, 300)}`,
      `\u9519\u8BEF\uFF1A${task.error ?? "unknown"}`,
      ...task.interrupted === true ? ["", "\u76EE\u6807\u7684 DSH \u91CD\u542F\uFF08\u6216\u8FD0\u884C\u65F6\u9000\u51FA\uFF09\u6253\u65AD\u4E86\u8FD9\u4E00\u8F6E\u3002\u5BF9\u8BDD\u548C\u4E0A\u4E0B\u6587\u8FD8\u5728\uFF1A\u7528 call_member send \u540C\u4E00\u4E2A taskId \u7EE7\u7EED\uFF0C\u6216\u91CD\u65B0 delegate \u4E00\u4E2A\u65B0\u4EFB\u52A1\u3002"] : [],
      "",
      `taskId: ${task.id}`
    ].join("\n");
    try {
      agent.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" }
      });
      task.notified = true;
      task.notifiedAt = (/* @__PURE__ */ new Date()).toISOString();
      task.notifyError = null;
      await this.#save(task);
      await this.#log(task, `notification queued into ${task.originSessionId}`);
    } catch (error) {
      task.notifyError = error instanceof Error ? error.message : String(error);
      await this.#save(task);
      await this.#log(task, `notification failed: ${task.notifyError}`);
    }
  }
  async status(taskId) {
    await this.#ensureLoaded();
    const task = this.tasks.get(String(taskId));
    if (task === void 0) return null;
    return task;
  }
  /**
   * Read the target member's host inventory from its interop service.
   * @param {string} member member id/name/ip/url.
   * @returns {Promise<object>} system information.
   */
  async system(member) {
    const target = await this.#resolveMember(member);
    const result = await this.#request(target.baseUrl, "GET", "/v1/system?sampleMs=200", void 0, 15e3);
    if (result?.system === void 0 || typeof result.system !== "object") {
      throw new Error("member interop returned no system information");
    }
    return { ...result.system, member: target.name, memberIp: target.ip };
  }
  async list() {
    await this.#ensureLoaded();
    return [...this.tasks.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  async logs(taskId, lines = 80) {
    await this.#ensureLoaded();
    const task = this.tasks.get(String(taskId));
    if (task === void 0) return "";
    try {
      const text = await readFile15(path22.join(this.taskRoot, `${task.id}.log`), "utf8");
      return text.split("\n").slice(-Math.max(1, Math.min(lines, 500))).join("\n");
    } catch {
      return "";
    }
  }
  /**
   * List the conversations every member's interop service currently controls.
   *
   * A slow or offline member degrades to an `error` entry so one bad peer does
   * not hide the rest of the list.
   * @param {number} [timeoutMs] per-member request budget.
   * @returns {Promise<{ok: boolean, updatedAt: string, groups: object[]}>} groups by member.
   */
  async listByMember(timeoutMs = 4e3) {
    const snapshot = await this.service.members();
    this.identity = this.identity ?? {
      id: String(snapshot.local?.id ?? "local"),
      name: String(snapshot.local?.name ?? snapshot.local?.id ?? "local"),
      ip: String(snapshot.local?.ip ?? "")
    };
    const members = [snapshot.local, ...Array.isArray(snapshot.members) ? snapshot.members : []].filter(Boolean);
    const groups = await Promise.all(members.map(async (member) => {
      const summary = {
        id: String(member.id),
        name: String(member.name ?? member.id),
        ip: String(member.ip ?? ""),
        online: member.online !== false,
        self: member.kind === "self",
        dsh: member.dsh === true
      };
      if (summary.ip === "") return { ...summary, conversations: [], error: "no VPN address" };
      try {
        const data = await this.#request(this.#baseUrl(summary.ip), "GET", "/v1/conversations", void 0, timeoutMs);
        return { ...summary, conversations: Array.isArray(data?.conversations) ? data.conversations : [], error: null };
      } catch (error) {
        return { ...summary, conversations: [], error: error instanceof Error ? error.message : String(error) };
      }
    }));
    groups.sort((left, right) => {
      if (left.self !== right.self) return left.self ? -1 : 1;
      if (left.online !== right.online) return left.online ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    return { ok: true, updatedAt: (/* @__PURE__ */ new Date()).toISOString(), groups };
  }
  /**
   * Delete the finished conversations each member's interop service holds. A
   * running one is left alone: its SDK session still owns it.
   * @param {number} timeoutMs per-member timeout.
   * @returns {Promise<{ok: boolean, removed: number, errors: object[]}>} summary.
   */
  async clearConversations(timeoutMs = 8e3) {
    const state = await this.service.members();
    const members = [state.local, ...Array.isArray(state.members) ? state.members : []].filter(Boolean);
    let removed = 0;
    const errors = [];
    for (const member of members) {
      const ip = String(member.ip ?? "");
      if (ip === "") continue;
      try {
        const data = await this.#request(this.#baseUrl(ip), "DELETE", "/v1/conversations", void 0, timeoutMs);
        if (Number.isInteger(data?.removed)) removed += data.removed;
      } catch (error) {
        errors.push({ member: String(member.name ?? ip), ip, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ok: true, removed, errors };
  }
  /**
   * Absolute path of one task's log file.
   * @param {string} taskId task id.
   * @returns {string} log path.
   */
  logPath(taskId) {
    return path22.join(this.taskRoot, `${String(taskId)}.log`);
  }
};

// src/lib/tools.mjs
function registerTools(ctx, toolsCtx, service) {
  const buildDefinition = {
    name: "build",
    description: [
      "\u4ECE\u56FA\u5B9A DSH \u6E90\u7801\u6784\u5EFA Web \u79BB\u7EBF\u5305\uFF0C\u5E76\u7B49\u5F85\u6784\u5EFA\u7ED3\u675F\u3002",
      "",
      "\u9ED8\u8BA4\u6E90\u7801\u662F https://github.com/deepseek-ai/deepseek-harness@master\uFF0C\u9ED8\u8BA4\u76EE\u6807 linux-x64 + win-x64\u3002",
      "\u6784\u5EFA\u4F1A\u4E0B\u8F7D\u6E90\u7801 tarball\u3001\u5E94\u7528 build/recipes.json \u7684\u8986\u76D6\u5C42\u3001\u8FD0\u884C pnpm install \u4E0E pnpm run build:web\uFF0C\u6700\u540E\u6253\u5305\uFF1B\u8017\u65F6\u6570\u5206\u949F\u5E76\u5360\u7528\u78C1\u76D8\u3002",
      "`planOnly` \u53EA\u5E94\u7528\u8986\u76D6\u5C42\u5E76\u5199\u5DE5\u4F5C\u5355\uFF0C\u4E0D\u5B89\u88C5\u3001\u4E0D\u6784\u5EFA\u3001\u4E0D\u6253\u5305\u3002",
      "\u5982\u679C\u8986\u76D6\u5C42\u4E0E\u4E0A\u6E38\u6E90\u7801\u4E0D\u5339\u914D\uFF0C\u6784\u5EFA\u505C\u5728 needs-fix \u5E76\u8FD4\u56DE job id\u3001\u5DE5\u4F5C\u5355\u548C\u5DE5\u4F5C\u6811\u3002",
      "\u8BA9 DSH \u4FEE\u597D\u5DE5\u4F5C\u6811\u540E\uFF0C\u518D\u6B21\u8C03\u7528 build \u5E76\u4F20\u5165\u540C\u4E00\u4E2A jobId\uFF1A\u8FD9\u6B21\u8C03\u7528\u4F1A\u81EA\u52A8\u628A\u4FEE\u6539\u56FA\u5316\u6210\u8986\u76D6\u5C42\uFF08\u66F4\u65B0 recipes\uFF09\uFF0C\u7136\u540E\u590D\u7528\u5DE5\u4F5C\u6811\u7EE7\u7EED\u6784\u5EFA\uFF1B\u4E0D\u9700\u8981 learn/resume \u547D\u4EE4\u3002",
      "\u6B63\u5E38\u7684\u4E0B\u4E00\u6B21 build \u4F1A\u76F4\u63A5\u4F7F\u7528\u56FA\u5316\u540E\u7684\u8986\u76D6\u5C42\u3002",
      "\u6784\u5EFA\u5B8C\u6210\u540E\u4F1A\u6E05\u7406\u66F4\u65E9 build \u7684 src/\u3001work-order/ \u548C dist/\uFF1B\u5F53\u524D job \u7684\u4EA7\u7269\u4FDD\u7559\u3002\u4F20 keepDist=true \u53EF\u4EE5\u4FDD\u7559\u65E7\u7684 dist/\u3002",
      "\u6CE8\u610F\uFF1A\u53EA\u5BF9\u53EF\u4FE1\u6E90\u7801\u4F7F\u7528\uFF1B\u8FD9\u4E2A\u5DE5\u5177\u662F\u540C\u6B65\u7684\uFF0C\u8C03\u7528\u4F1A\u4E00\u76F4\u7B49\u5230 done / planned / needs-fix / failed\uFF0C\u5E76\u5728 text \u548C data.logFile \u4E2D\u8FD4\u56DE\u65E5\u5FD7\u8DEF\u5F84\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "\u6E90\u7801 URL \u6216\u672C\u5730\u76EE\u5F55\u3002\u7701\u7565\u65F6\u7528\u914D\u7F6E\uFF0C\u518D\u9ED8\u8BA4\u56FA\u5B9A GitHub \u6E90\u3002"
        },
        ref: {
          type: "string",
          description: "\u5206\u652F\u3001tag \u6216 commit\u3002\u7701\u7565\u65F6\u7528 master\u3002"
        },
        targets: {
          type: "array",
          items: { type: "string" },
          description: '\u76EE\u6807\u5217\u8868\uFF0C\u4F8B\u5982 ["linux-x64","win-x64"]\u3002\u7701\u7565\u65F6\u7528\u914D\u7F6E\u3002'
        },
        planOnly: {
          type: "boolean",
          description: "\u53EA\u5E94\u7528\u8986\u76D6\u5C42\u5E76\u5199\u5DE5\u4F5C\u5355\uFF0C\u4E0D\u8FD0\u884C pnpm install/build\u3002"
        },
        version: {
          type: "string",
          description: "\u8986\u76D6\u5305\u7248\u672C\u53F7\u3002"
        },
        jobId: {
          type: "string",
          description: "needs-fix \u7684 job id\uFF1A\u5148\u56FA\u5316\u5DE5\u4F5C\u6811\u91CC\u7684\u4FEE\u6539\uFF0C\u518D\u7EE7\u7EED\u540C\u4E00\u4E2A job\u3002"
        },
        keepDist: {
          type: "boolean",
          description: "build \u5B8C\u6210\u540E\u6E05\u7406\u66F4\u65E9 job \u65F6\u4FDD\u7559 dist/\uFF1B\u9ED8\u8BA4\u5220\u9664\u3002"
        }
      },
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean", required: true },
          text: { type: "string" },
          data: { type: "object", additionalProperties: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: typeof value.text === "string" ? value.text : JSON.stringify(value)
      }]
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const data = await service.build({
        source: typeof args.source === "string" ? args.source : void 0,
        ref: typeof args.ref === "string" ? args.ref : void 0,
        targets: Array.isArray(args.targets) ? args.targets : void 0,
        planOnly: args.planOnly === true,
        version: typeof args.version === "string" ? args.version : void 0,
        jobId: typeof args.jobId === "string" ? args.jobId : void 0,
        keepDist: args.keepDist === true
      });
      return {
        ok: data.status === "done" || data.status === "planned",
        text: formatBuild(data),
        data
      };
    }
  };
  const deployDefinition = {
    name: "deploy",
    description: [
      "\u901A\u8FC7 SSH \u628A dsh-mesh \u79BB\u7EBF\u5305\u90E8\u7F72\u5230\u76EE\u6807\u4E3B\u673A\uFF0C\u5E76\u7B49\u5F85\u90E8\u7F72\u7ED3\u675F\u3002",
      "",
      "\u8F93\u5165\u53EA\u6709 package \u548C\u76EE\u6807 host\u3002",
      "host \u662F\u5DF2\u53D1\u73B0\u7684\u6210\u5458\u65F6\uFF0C\u81EA\u52A8\u89E3\u6790\u6210\u5458 IP\u3001SSH \u7528\u6237/\u79C1\u94A5\u3001OS \u548C\u5B89\u88C5\u76EE\u5F55\uFF1B",
      "\u5426\u5219\u6309\u666E\u901A SSH \u4E3B\u673A\u5904\u7406\uFF0C\u76EE\u6807 OS \u7531\u5305\u540D\uFF08win / linux\uFF09\u51B3\u5B9A\uFF0C\u5B89\u88C5\u76EE\u5F55\u7528\u9ED8\u8BA4\u503C\u3002",
      "\u56FA\u5B9A\u6D41\u7A0B\uFF1A\u4E0A\u4F20\u5305 \u2192 prepare \u5230\u65B0\u7684 release \u2192 \u5207\u6362 current \u2192 control \u2192 dsh \u2192 gate \u91CD\u542F \u2192 \u5065\u5EB7\u68C0\u67E5\uFF1B",
      "\u5065\u5EB7\u68C0\u67E5\u5931\u8D25\u4F1A\u81EA\u52A8\u5207\u56DE previous\u3002",
      "\u540C\u6B65\u8FD4\u56DE\u6700\u7EC8 job\uFF0C\u4EE5\u53CA text \u548C data.logFile \u4E2D\u7684\u65E5\u5FD7\u8DEF\u5F84\u3002",
      "\u76EE\u6807\u5FC5\u987B\u5DF2\u7ECF\u5B89\u88C5\u8FC7\u4E00\u6B21\uFF08\u5171\u4EAB config/gate.env \u5B58\u5728\uFF09\uFF0CSSH \u9700\u975E\u4EA4\u4E92\u53EF\u7528\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "\u76EE\u6807 SSH \u4E3B\u673A\u540D/IP\uFF0C\u4E5F\u53EF\u4EE5\u662F\u6210\u5458 id\u3001\u540D\u79F0\u6216 VPN IP\u3002" },
        package: { type: "string", description: "\u672C\u5730\u79BB\u7EBF\u5305\u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216 ~/.dsh/packages\u3001dist \u4E0B\u7684\u6587\u4EF6\u540D\u3002" }
      },
      required: ["host", "package"],
      additionalProperties: false
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{
        type: "text",
        text: typeof value?.text === "string" ? value.text : JSON.stringify(value, null, 2)
      }]
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const data = await service.deployPackage({
        host: args.host,
        package: args.package
      });
      return {
        ok: data.job?.status === "succeeded",
        text: formatDeployResult(data),
        data
      };
    }
  };
  const memberTasks = new MemberTaskService({
    ctx,
    service,
    dataDir: service.dataDir,
    log: (line) => ctx.logger?.info?.(`mesh: ${line}`)
  });
  service.memberTasks = memberTasks;
  try {
    ctx.effect(() => () => memberTasks.dispose(), "mesh member tasks");
  } catch {
  }
  const callMemberDefinition = {
    name: "call_member",
    description: [
      "\u628A\u4EFB\u52A1\u4EA4\u7ED9\u53E6\u4E00\u4E2A WireGuard \u6210\u5458\u4E0A\u7684 DSH \u5BF9\u8BDD\u3002",
      "",
      "`delegate`\uFF1A\u5728\u6210\u5458 B \u4E0A\u521B\u5EFA\u5BF9\u8BDD\u5E76\u7ACB\u5373\u8FD4\u56DE taskId\uFF1B\u4E0D\u4F1A\u540C\u6B65\u7B49\u5F85\u3002",
      "`send`\uFF1A\u5411\u5DF2\u7ECF\u521B\u5EFA\u7684\u6210\u5458\u4EFB\u52A1\u5BF9\u8BDD\u7EE7\u7EED\u53D1\u6D88\u606F\uFF0C\u7ACB\u5373\u8FD4\u56DE\uFF1B\u4E0D\u4F1A\u81EA\u52A8\u7B49\u5F85\u6216\u901A\u77E5\u3002",
      "\u7528 wait_member \u7B49\u7ED3\u679C\uFF1A\u6210\u5458\u6BCF\u7ED3\u675F\u4E00\u8F6E\u56DE\u7B54\u5C31\u8FD4\u56DE\u4E00\u6B21\uFF08state=progress \u8868\u793A\u8FD8\u4F1A\u7EE7\u7EED\uFF09\uFF0C",
      "\u53EA\u6709 state=done \u624D\u662F\u6574\u6BB5\u4EFB\u52A1\u7684\u6700\u7EC8\u7ED3\u679C\uFF1B\u8D85\u65F6\uFF08state=running\uFF09\u7528\u540C\u4E00\u4E2A taskId \u63A5\u7740\u7B49\u3002",
      "\u8FD4\u56DE\u503C\u5E26 data.logFile\uFF0C\u6307\u5411\u8BE5\u4EFB\u52A1\u7684\u65E5\u5FD7\u6587\u4EF6\u3002",
      "",
      "\u6210\u5458\u901A\u8FC7 WireGuard \u6210\u5458\u53D1\u73B0\u89E3\u6790\uFF08id/name/IP \u5747\u53EF\uFF09\uFF1B\u76EE\u6807 B \u7684 8765 interop \u670D\u52A1\u5FC5\u987B\u53EF\u8FBE\uFF0Ctoken \u9ED8\u8BA4\u590D\u7528\u7F51\u5173\u5BC6\u7801\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["delegate", "send"],
          description: "\u8981\u6267\u884C\u7684\u52A8\u4F5C\u3002"
        },
        member: { type: "string", description: "\u6210\u5458 id\u3001\u540D\u79F0\u3001VPN IP \u6216 http(s) URL\u3002" },
        prompt: { type: "string", description: "delegate\uFF1A\u4EA4\u7ED9\u6210\u5458 B \u7684\u4EFB\u52A1\u3002" },
        content: { type: "string", description: "send\uFF1A\u7EE7\u7EED\u53D1\u7ED9\u6210\u5458 B \u5BF9\u8BDD\u7684\u6D88\u606F\u3002" },
        taskId: { type: "string", description: "send \u7684\u4EFB\u52A1 id\u3002" },
        cwd: { type: "string", description: "delegate\uFF1A\u6210\u5458 B \u4E0A\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u53EF\u7A7A\uFF09\u3002" },
        workspace: { type: "string", description: "delegate\uFF1A\u6210\u5458 B \u4E0A\u7684\u4EFB\u52A1\u5DE5\u4F5C\u533A\u540D\u79F0\uFF1B\u5B9E\u9645\u76EE\u5F55\u56FA\u5B9A\u4E3A\u6210\u5458\u672C\u673A\u7684 ~/.dsh/workspaces/<name>\u3002\u548C cwd \u4E8C\u9009\u4E00\u3002" }
      },
      required: ["action"],
      additionalProperties: false
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{
        type: "text",
        text: typeof value?.text === "string" ? value.text : JSON.stringify(value, null, 2)
      }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const action = String(args.action);
      if (action === "delegate") {
        if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw new Error("this action needs prompt");
        const task = await memberTasks.start({
          member: args.member,
          prompt: args.prompt,
          cwd: args.cwd,
          workspace: args.workspace,
          agent: exec.agent,
          notify: false,
          signal: exec.signal
        });
        const data = { ...task, logFile: memberTasks.logPath(task.id) };
        return {
          ok: task.status !== "failed",
          text: [
            `\u5DF2\u53D1\u8D77\u6210\u5458\u4EFB\u52A1 ${task.id}\uFF1A${task.member}\uFF08${task.memberIp}\uFF09\uFF0C\u5BF9\u8BDD ${task.conversationId}\u3002`,
            `\u7528 wait_member \u7B49\u5F85\u7ED3\u679C\uFF1AtaskId="${task.id}"\uFF0CtimeoutMs=30000\uFF08\u53EF\u6309\u9700\u8C03\u5927\uFF0C\u6700\u5927 300000\uFF09\u3002`,
            "\u6210\u5458\u6BCF\u7ED3\u675F\u4E00\u8F6E\u56DE\u7B54\u5C31\u8FD4\u56DE\u4E00\u6B21\uFF08state=progress\uFF09\uFF0C\u62FF\u5230 state=done \u624D\u662F\u6700\u7EC8\u7ED3\u679C\u3002",
            task.status === "failed" ? `\u5F53\u524D\u72B6\u6001\uFF1Afailed\uFF0C${task.error ?? ""}` : "",
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data
        };
      }
      if (action === "send") {
        if (typeof args.taskId !== "string" || args.taskId === "") throw new Error("send needs taskId");
        if (typeof args.content !== "string" || args.content.trim() === "") throw new Error("send needs content");
        const task = await memberTasks.send(args.taskId, args.content, exec.signal);
        const data = { ...task, logFile: memberTasks.logPath(task.id) };
        return {
          ok: true,
          text: [
            `\u5DF2\u53D1\u9001\u5230 ${task.member} \u7684\u5BF9\u8BDD ${task.conversationId}\u3002`,
            `\u7528 wait_member \u7B49\u5F85\u56DE\u590D\uFF1AtaskId="${task.id}"\uFF0CtimeoutMs=30000\uFF1B\u540C\u6837\u6BCF\u8F6E\u8FD4\u56DE\u4E00\u6B21\uFF0Cstate=done \u624D\u662F\u6700\u7EC8\u7ED3\u679C\u3002`,
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].join("\n"),
          data
        };
      }
      throw new Error(`unknown action: ${action}`);
    }
  };
  const waitMemberDefinition = {
    name: "wait_member",
    description: [
      "\u7B49\u5F85\u4E00\u4E2A\u7531 call_member \u53D1\u8D77\u7684\u6210\u5458\u4EFB\u52A1\uFF0C\u6700\u591A timeoutMs \u6BEB\u79D2\u3002",
      "",
      "\u6210\u5458\u5BF9\u8BDD\u4E00\u6709\u65B0\u56DE\u590D\uFF08\u4E00\u8F6E\u7ED3\u675F\uFF09\u5C31\u7ACB\u523B\u8FD4\u56DE\uFF0C\u4E0D\u7B49\u5230\u6574\u6BB5\u4EFB\u52A1\u7ED3\u675F\uFF1B\u8FD4\u56DE\u503C\u5E26 state\uFF1A",
      "progress\uFF1A\u672C\u8F6E\u56DE\u590D\u5DF2\u8FD4\u56DE\uFF0C\u4F46\u6210\u5458\u8FD8\u4F1A\u7EE7\u7EED\uFF08\u53EF\u80FD\u8FD8\u6709\u672A\u5B8C\u6210\u7684\u5B50\u4EE3\u7406\uFF09\uFF1B\u7528\u540C\u4E00\u4E2A taskId \u518D\u7B49\u4E0B\u4E00\u8F6E\u3002",
      "done\uFF1A\u6574\u6BB5\u4EFB\u52A1\u5B8C\u6210\uFF0C\u8FD4\u56DE\u6700\u7EC8\u6587\u672C\u3002",
      "\u8D85\u65F6\uFF1Adone=false\u3001state=running\uFF0C\u7528\u540C\u4E00\u4E2A taskId \u7EE7\u7EED\u7B49\u5373\u53EF\uFF0C\u671F\u95F4\u4EA7\u751F\u7684\u56DE\u590D\u4E0D\u4F1A\u4E22\u3002",
      "\u5931\u8D25/\u4E2D\u65AD\uFF1A\u8FD4\u56DE\u9519\u8BEF\uFF1B\u76EE\u6807 DSH \u91CD\u542F\u65F6\u53EF\u4EE5\u7528 call_member send \u7EE7\u7EED\u8BE5\u5BF9\u8BDD\u3002",
      "\u6BCF\u6B21\u8C03\u7528\u6709\u4E0A\u9650\uFF08\u9ED8\u8BA4 30000\uFF0C\u6700\u5927 300000 \u6BEB\u79D2\uFF09\uFF0C\u4E0D\u4F1A\u65E0\u9650\u963B\u585E\uFF1B\u7528\u6237\u505C\u6B62\u5F53\u524D\u5BF9\u8BDD\u4F1A\u4E2D\u6B62\u672C\u6B21\u7B49\u5F85\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "call_member \u8FD4\u56DE\u7684 taskId\u3002" },
        timeoutMs: { type: "integer", minimum: 1e3, maximum: 3e5, description: "\u672C\u6B21\u7B49\u5F85\u4E0A\u9650\uFF0C\u9ED8\u8BA4 30000 \u6BEB\u79D2\u3002" }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{
        type: "text",
        text: typeof value?.text === "string" ? value.text : JSON.stringify(value, null, 2)
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const timeoutMs = Number.isSafeInteger(args.timeoutMs) ? args.timeoutMs : 3e4;
      const result = await memberTasks.wait(args.taskId, { timeoutMs, signal: exec.signal });
      const task = result.task;
      const replies = Array.isArray(result.replies) ? result.replies : [];
      const replyText = replies.map((reply) => reply.text).join("\n\n").trim();
      const data = {
        ...task,
        done: result.done,
        timedOut: result.timedOut,
        state: result.state,
        text: replyText,
        replies,
        logFile: memberTasks.logPath(task.id)
      };
      const turn = Number.isSafeInteger(task.turns) && task.turns > 0 ? `\u7B2C ${String(task.turns)} \u8F6E` : "";
      const where = `${task.member}\uFF08${task.memberIp}\uFF09\uFF0C\u5BF9\u8BDD ${task.conversationId}`;
      if (!result.done && result.state === "progress") {
        return {
          ok: true,
          text: [
            `\u6210\u5458\u4EFB\u52A1 ${task.id} \u8FDB\u884C\u4E2D${turn === "" ? "" : `\uFF08${turn}\uFF0C\u5C1A\u672A\u7ED3\u675F\uFF09`}\uFF1A${where}\u3002`,
            replyText !== "" ? `\u672C\u8F6E\u56DE\u590D\uFF1A
${replyText}` : "",
            "\u6210\u5458\u8FD8\u4F1A\u7EE7\u7EED\uFF08\u53EF\u80FD\u8FD8\u6709\u5B50\u4EE3\u7406\u5728\u8DD1\uFF09\uFF0C\u8FD9\u4E0D\u662F\u6700\u7EC8\u7ED3\u679C\u3002",
            `\u8BF7\u7EE7\u7EED\u8C03\u7528 wait_member \u7B49\u4E0B\u4E00\u8F6E\uFF1AtaskId="${task.id}"\uFF0CtimeoutMs=30000\uFF1B\u6536\u5230 state=done \u624D\u662F\u6700\u7EC8\u7ED3\u679C\u3002`,
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data
        };
      }
      if (result.done && task.status === "completed") {
        const finalText = replyText !== "" ? replyText : typeof task.lastText === "string" ? task.lastText : "";
        return {
          ok: true,
          text: [
            `\u6210\u5458\u4EFB\u52A1 ${task.id} \u5DF2\u5B8C\u6210\uFF1A${where}\u3002`,
            "\uFF08\u4EFB\u52A1\u5DF2\u7ED3\u675F\uFF0C\u4E0D\u9700\u8981\u518D\u8C03\u7528 wait_member\uFF1B\u8981\u7EE7\u7EED\u8FD9\u4E2A\u5BF9\u8BDD\u7528 call_member send\u3002\uFF09",
            "\u7ED3\u679C\uFF1A",
            finalText !== "" ? finalText : "(\u6210\u5458\u6CA1\u6709\u8FD4\u56DE\u6587\u672C\u7ED3\u679C)",
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].join("\n"),
          data
        };
      }
      if (!result.done) {
        const effective = Math.min(3e5, Math.max(1e3, timeoutMs));
        return {
          ok: true,
          text: [
            `\u6210\u5458\u4EFB\u52A1 ${task.id} \u4ECD\u5728\u8FD0\u884C${turn === "" ? "" : `\uFF08${turn}\uFF0C\u5C1A\u672A\u7ED3\u675F\uFF09`}\uFF1A${where}\u3002`,
            "\u8FD9\u6BB5\u65F6\u95F4\u6CA1\u6709\u65B0\u56DE\u590D\uFF0C\u4F46\u4EFB\u52A1\u6CA1\u6709\u7ED3\u675F\u3001\u671F\u95F4\u7684\u56DE\u590D\u4E5F\u4E0D\u4F1A\u4E22\u3002",
            `\u8BF7\u7EE7\u7EED\u8C03\u7528 wait_member\uFF1AtaskId="${task.id}"\uFF0CtimeoutMs=${String(effective)}\uFF1B\u6536\u5230 state=done \u624D\u662F\u6700\u7EC8\u7ED3\u679C\u3002`,
            typeof task.lastText === "string" && task.lastText !== "" ? `\u6700\u8FD1\u8F93\u51FA\uFF1A${task.lastText.slice(0, 500)}` : "",
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data
        };
      }
      return {
        ok: false,
        text: [
          `\u6210\u5458\u4EFB\u52A1 ${task.id} ${task.status}\uFF08\u5DF2\u7ED3\u675F\uFF09\uFF1A${where}\u3002`,
          `\u539F\u56E0\uFF1A${task.error ?? "unknown"}`,
          replyText !== "" ? `\u4E2D\u65AD\u524D\u7684\u56DE\u590D\uFF1A
${replyText}` : "",
          task.interrupted === true ? "\u76EE\u6807\u6210\u5458\u7684 DSH \u91CD\u542F\u6216\u8FD0\u884C\u65F6\u9000\u51FA\u6253\u65AD\u4E86\u8FD9\u4E00\u8F6E\uFF1B\u53EF\u4EE5\u7528 call_member send \u540C\u4E00\u4E2A taskId \u7EE7\u7EED\u3002" : "",
          `\u65E5\u5FD7\uFF1A${data.logFile}`
        ].filter((line) => line !== "").join("\n"),
        data
      };
    }
  };
  const membersDefinition = {
    name: "members",
    description: [
      "\u53D1\u73B0\u5F53\u524D WireGuard \u7F51\u7EDC\u91CC\u7684\u6240\u6709 DSH \u6210\u5458\u3002",
      "",
      "\u8FD4\u56DE\u6BCF\u4E2A\u6210\u5458\u7684 id\u3001\u540D\u79F0\u3001VPN IP\u3001\u5728\u7EBF\u72B6\u6001\u3001DSH \u7AEF\u53E3\u3001\u5EF6\u8FDF\u3001\u7CFB\u7EDF\u4FE1\u606F\uFF08CPU/\u5185\u5B58/\u78C1\u76D8/home/\u90E8\u7F72\u76EE\u5F55/\u8FD0\u884C\u7528\u6237\uFF09\u548C\u7528\u6237\u6807\u7B7E\u3002",
      "\u6570\u636E\u4E0E\u9762\u677F\u300C\u6210\u5458\u300D\u9875\u4E00\u81F4\uFF1B\u672C\u673A\u4F5C\u4E3A id=local \u7684\u4E00\u884C\u8FD4\u56DE\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{
        type: "text",
        text: typeof value?.text === "string" ? value.text : JSON.stringify(value, null, 2)
      }]
    },
    isConcurrencySafe: () => true,
    async execute() {
      const data = await service.members();
      return { ok: true, text: formatMembers(data), data };
    }
  };
  const repackDefinition = {
    name: "repack",
    description: [
      "\u7528\u5F53\u524D\u4ED3\u5E93\u5237\u65B0\u4E00\u4E2A\u5DF2\u6709\u7684\u79BB\u7EBF\u5305\uFF08\u4E0D\u91CD\u5EFA DSH \u4E3B\u4F53\uFF09\u3002",
      "",
      "\u89E3\u5305 \u2192 \u7528\u4ED3\u5E93\u7684 gate/\u3001shared/\u3001config/\u3001code/*\u3001\u6839\u811A\u672C\u548C plugins/dsh-mesh/ \u8986\u76D6\u5305\u5185\u5BF9\u5E94\u6587\u4EF6\uFF0C",
      "app/\u3001web/\u3001runtime/node/ \u539F\u6837\u4FDD\u7559 \u2192 \u91CD\u65B0\u538B\u7F29\u5E76\u628A .sha256 \u8FB9\u8F66\u66F4\u65B0\u6389\u3002",
      "\u9002\u5408\u53EA\u6539\u4E86\u7F51\u5173\u6216\u63D2\u4EF6\u3001\u4E0D\u60F3\u91CD\u65B0\u4E0B\u8F7D\u4F9D\u8D56\u548C Node \u8FD0\u884C\u65F6\u7684\u573A\u666F\uFF1B\u8017\u65F6\u7EA6\u51E0\u5341\u79D2\u5230\u4E24\u5206\u949F\u3002",
      "package \u53EF\u4EE5\u662F ~/.dsh/packages \u91CC\u7684\u6587\u4EF6\u540D\uFF0C\u4E5F\u53EF\u4EE5\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF1B.tar.gz/.tgz \u4E0E .zip \u90FD\u652F\u6301\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        package: { type: "string", description: "\u79BB\u7EBF\u5305\u6587\u4EF6\u540D\uFF08~/.dsh/packages \u4E0B\uFF09\u6216\u7EDD\u5BF9\u8DEF\u5F84\u3002" }
      },
      required: ["package"],
      additionalProperties: false
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{
        type: "text",
        text: typeof value?.text === "string" ? value.text : JSON.stringify(value, null, 2)
      }]
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const data = await service.repackPackage({ package: args.package });
      const size = typeof data.bytes === "number" ? `${data.bytes} \u5B57\u8282` : "\u672A\u77E5\u5927\u5C0F";
      return {
        ok: data.ok === true,
        text: `\u5DF2\u91CD\u65B0\u6253\u5305 ${data.package}
\u5927\u5C0F ${size}
sha256 ${data.sha256}
\u5305\u5185\u6587\u4EF6 ${data.files} \u4E2A\uFF08DSH \u4E3B\u4F53\u672A\u91CD\u5EFA\uFF09`,
        data
      };
    }
  };
  for (const tool of [buildDefinition, deployDefinition, callMemberDefinition, waitMemberDefinition, membersDefinition, repackDefinition]) {
    try {
      toolsCtx.tools.register(tool);
      ctx.logger?.info?.(`mesh: registered tool ${tool.name}`);
    } catch (error) {
      ctx.logger?.error?.(`mesh: cannot register tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
function formatBuild(job) {
  const lines = [
    `${job.id}  ${job.status}  ${job.phase}`,
    `\u6E90\u7801\uFF1A${job.source}@${job.ref}`,
    `\u76EE\u6807\uFF1A${Array.isArray(job.targets) ? job.targets.join(", ") : "\u2014"}`
  ];
  if (job.logFile) lines.push(`\u65E5\u5FD7\uFF1A${job.logFile}`);
  if (job.stateFile) lines.push(`\u72B6\u6001\uFF1A${job.stateFile}`);
  if (job.error) lines.push(`\u9519\u8BEF\uFF1A${job.error}`);
  if (job.status === "needs-fix") {
    lines.push(`\u8986\u76D6\u5C42\u4E0E\u4E0A\u6E38\u6E90\u7801\u4E0D\u5339\u914D\uFF0C\u6784\u5EFA\u505C\u5728 apply\uFF1B\u4FEE\u590D\u5DE5\u4F5C\u6811\u540E\u8C03\u7528 build { "jobId": "${job.id}" }\uFF0C\u4F1A\u81EA\u52A8\u56FA\u5316\u8986\u76D6\u5C42\u5E76\u7EE7\u7EED\u3002`);
  }
  if (job.workOrder) {
    lines.push(`\u5DE5\u4F5C\u5355\uFF1A${job.workOrder.markdown}`);
    lines.push(`\u5B50\u4EE3\u7406\u63D0\u793A\uFF1A${job.workOrder.prompt}`);
  }
  for (const artifact of job.artifacts ?? []) {
    lines.push(`\u4EA7\u7269 ${artifact.target}\uFF1A${artifact.archive}\uFF08${formatBytes3(artifact.bytes)}\uFF09`);
  }
  const tail = Array.isArray(job.logTail) ? job.logTail.slice(-15) : [];
  if (tail.length > 0) lines.push("\u6700\u8FD1\u65E5\u5FD7\uFF1A", ...tail);
  return lines.join("\n");
}
function formatDeployResult(result) {
  const job = result.job ?? {};
  const lines = [`${job.id ?? "deploy"}  ${job.status ?? "unknown"}  ${job.phase ?? ""}`];
  if (result.member) lines.push(`\u6210\u5458\uFF1A${result.member.name}\uFF08${result.member.ip}\uFF09`);
  if (job.target) {
    const target = job.target;
    lines.push(`\u76EE\u6807\uFF1A${target.user ? `${target.user}@` : ""}${target.host}:${target.port}\uFF08${target.os}\uFF09`);
    lines.push(`\u5B89\u88C5\u6839\uFF1A${target.appRoot}`);
  }
  if (job.release) lines.push(`\u53D1\u5E03\uFF1A${job.release}`);
  if (job.error) lines.push(`\u9519\u8BEF\uFF1A${job.error}`);
  if (result.logFile) lines.push(`\u65E5\u5FD7\uFF1A${result.logFile}`);
  const log = String(result.log ?? "").trimEnd();
  if (log !== "") lines.push("\u6700\u8FD1\u65E5\u5FD7\uFF1A", ...log.split(/\r?\n/u).slice(-25));
  return lines.join("\n");
}
function formatMembers(snapshot) {
  const lines = [`\u66F4\u65B0\u4E8E ${snapshot.updatedAt}\uFF0C\u5171 ${snapshot.members.length} \u4E2A\u6210\u5458`];
  for (const member of snapshot.members) {
    const status = member.id === "local" ? "\u672C\u673A" : member.dsh ? `DSH :${member.port}` : "\u672A\u90E8\u7F72/\u4E0D\u53EF\u8FBE";
    const tag = member.tag ? ` [${member.tag}]` : "";
    const ip = member.ip ? ` ${member.ip}` : "";
    lines.push(`- ${member.name}${tag}${ip}  ${member.id}  ${status}  ${member.online ? "online" : "offline"}`);
  }
  if (snapshot.warnings?.length) lines.push(`\u8B66\u544A\uFF1A${snapshot.warnings.join("\uFF1B")}`);
  return lines.join("\n");
}
function formatBytes3(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = amount;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? String(Math.round(size)) : size.toFixed(1)} ${units[unit]}`;
}

// src/lib/interop-service.mjs
import { execFile as execFile3 } from "node:child_process";
import { createHash as createHash8, randomBytes as randomBytes3, randomUUID as randomUUID2, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { existsSync as existsSync13, mkdirSync as mkdirSync2, readFileSync as readFileSync6, readdirSync as readdirSync2, renameSync, writeFileSync } from "node:fs";
import http3 from "node:http";
import { homedir as homedir3 } from "node:os";
import path23 from "node:path";
import { promisify as promisify3 } from "node:util";

// code/shared/conversation-meta.mjs
var TITLE_LIMIT = 80;
var INITIATOR_LIMIT = 64;
var PREVIEW_LIMIT = 400;
var PROMPT_LIMIT = 8e3;
function clip(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/gu, " ").trim();
  if (text === "") return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}\u2026` : text;
}
function normalizeTitle(value) {
  return clip(value, TITLE_LIMIT);
}
function titleFromPrompt(value) {
  if (typeof value === "string") return clip(value, TITLE_LIMIT);
  if (!Array.isArray(value)) return "";
  const parts = [];
  for (const block of value) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return clip(parts.join(" "), TITLE_LIMIT);
}
function promptText(value, limit = PROMPT_LIMIT) {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    const parts = [];
    for (const block of value) {
      if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    text = parts.join("\n\n");
  }
  if (text === "") return "";
  return text.length > limit ? text.slice(0, limit) : text;
}
function normalizeInitiator(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const initiator = {};
  for (const key of ["id", "name", "ip", "source"]) {
    const text = clip(value[key], INITIATOR_LIMIT);
    if (text !== "") initiator[key] = text;
  }
  return initiator.id === void 0 && initiator.name === void 0 ? null : initiator;
}
function conversationRecord(conversation) {
  return {
    id: conversation.id,
    sessionId: conversation.sessionId,
    title: conversation.title ?? "",
    initiator: conversation.initiator ?? null,
    status: conversation.status,
    cwd: conversation.cwd,
    // Kept so the panel can show what was sent and which workspace it named,
    // even after a restart replaced the in-memory conversation.
    prompt: typeof conversation.prompt === "string" ? conversation.prompt : "",
    workspace: typeof conversation.workspace === "string" ? conversation.workspace : "",
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastText: clip(conversation.lastText, PREVIEW_LIMIT),
    // The failure a turn ended with must survive the restart that follows it;
    // otherwise the panel and the waiting member see a completed task with no
    // result.
    error: typeof conversation.error === "string" && conversation.error !== "" ? conversation.error : null,
    turns: Number.isSafeInteger(conversation.turns) ? conversation.turns : 0
  };
}
var INTERRUPTED_STATUS = "interrupted";
var INTERRUPTED_ERROR = "interrupted by a DSH restart; send a message to resume this conversation";
var ABANDONED_STATUSES = /* @__PURE__ */ new Set(["running", "starting", "unavailable"]);
function restoredConversation(record, workdir) {
  const status = typeof record?.status === "string" ? record.status : "idle";
  const abandoned = ABANDONED_STATUSES.has(status);
  return {
    id: String(record.id),
    sessionId: typeof record.sessionId === "string" ? record.sessionId : String(record.id),
    cwd: typeof record.cwd === "string" ? record.cwd : workdir,
    status: abandoned ? INTERRUPTED_STATUS : status,
    title: typeof record.title === "string" ? record.title : "",
    prompt: typeof record.prompt === "string" ? record.prompt.slice(0, PROMPT_LIMIT) : "",
    workspace: typeof record.workspace === "string" ? record.workspace : "",
    initiator: normalizeInitiator(record.initiator),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : (/* @__PURE__ */ new Date()).toISOString(),
    lastText: typeof record.lastText === "string" ? record.lastText : "",
    error: abandoned ? INTERRUPTED_ERROR : typeof record.error === "string" && record.error !== "" ? record.error : null,
    turns: Number.isSafeInteger(record.turns) ? record.turns : 0
  };
}

// code/shared/conversation-replies.mjs
var MAX_REPLIES = 50;
function assistantText(event) {
  if (event?.type !== "assistant/message") return "";
  const blocks = event?.data?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
function applySessionEvent(conversation, event) {
  const type = event?.type;
  if (type === "assistant/message") {
    const text2 = assistantText(event);
    if (text2 === "") return null;
    conversation.lastText = text2;
    conversation.turnText = typeof conversation.turnText === "string" ? `${conversation.turnText}${text2}` : text2;
    return null;
  }
  if (type === "turn/start") {
    conversation.turnText = "";
    conversation.error = null;
    return null;
  }
  if (type !== "turn/end") return null;
  conversation.turns = Number.isSafeInteger(conversation.turns) ? conversation.turns + 1 : 1;
  if (event?.data?.reason?.kind === "error") {
    conversation.error = event.data.reason.error?.message ?? "turn ended with an error";
  }
  const text = (typeof conversation.turnText === "string" ? conversation.turnText : "").trim();
  conversation.turnText = "";
  if (text === "") return null;
  const reply = {
    seq: (Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0) + 1,
    turn: conversation.turns,
    text,
    at: (/* @__PURE__ */ new Date()).toISOString()
  };
  conversation.replySeq = reply.seq;
  if (!Array.isArray(conversation.replies)) conversation.replies = [];
  conversation.replies.push(reply);
  if (conversation.replies.length > MAX_REPLIES) {
    conversation.replies.splice(0, conversation.replies.length - MAX_REPLIES);
  }
  return reply;
}
function repliesSince(conversation, since) {
  const after = Number.isSafeInteger(since) && since > 0 ? since : 0;
  const replies = Array.isArray(conversation.replies) ? conversation.replies : [];
  return replies.filter((reply) => reply.seq > after);
}
function summarizeReplies(replies) {
  const text = replies.map((reply) => reply.text).join("\n\n").trim();
  const last = replies[replies.length - 1];
  return {
    text,
    turn: last === void 0 ? null : last.turn,
    seq: last === void 0 ? null : last.seq
  };
}

// src/lib/interop-service.mjs
var execFileAsync2 = promisify3(execFile3);
var MAX_EVENTS = 5e3;
var EMBEDDED_INTEROP_MARKER = "dsh-mesh-embedded-interop-v1";
var MAX_BODY = 1024 * 1024;
var SETTLE_MS = 300;
function readEnvFile(file) {
  const values = {};
  if (!existsSync13(file)) return values;
  for (const raw of readFileSync6(file, "utf8").split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}
function configCandidates() {
  const candidates = [];
  const explicit = process.env.DSH_INTEROP_CONFIG;
  if (typeof explicit === "string" && explicit.trim() !== "") candidates.push(path23.resolve(explicit));
  const packageRoot = process.env.DSH_PACKAGE_ROOT;
  if (typeof packageRoot === "string" && packageRoot.trim() !== "") {
    candidates.push(path23.join(packageRoot, "config", "interop.env"));
  }
  const home = process.env.DSH_HOME;
  if (typeof home === "string" && home.trim() !== "") {
    candidates.push(path23.join(path23.dirname(home), "config", "interop.env"));
    candidates.push(path23.join(home, "config", "interop.env"));
  }
  let current = process.cwd();
  for (let depth = 0; depth < 7; depth += 1) {
    candidates.push(path23.join(current, "config", "interop.env"));
    const parent = path23.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}
function findInteropConfig() {
  for (const candidate of configCandidates()) {
    if (existsSync13(candidate)) return candidate;
  }
  return null;
}
function asBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/iu.test(value.trim());
}
function resolveInteropSettings(config = {}) {
  const file = findInteropConfig();
  const root = file === null ? null : path23.dirname(path23.dirname(file));
  const values = file === null ? {} : readEnvFile(file);
  const setting = (name, fallback) => {
    const fromEnv = process.env[name];
    if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
    if (typeof values[name] === "string" && values[name] !== "") return values[name];
    return fallback;
  };
  const useGatePassword = asBool(
    setting("DSH_INTEROP_USE_GATE_PASSWORD", config.interopUseGatePassword === true ? "1" : "0"),
    false
  );
  const dataDir = root === null ? path23.join(process.env.DSH_HOME ?? path23.join(process.cwd(), ".dsh"), "mesh", "interop") : path23.join(root, "data");
  const tokenFile = path23.join(dataDir, "interop-token");
  let gatePassword = typeof process.env.DSH_GATE_PASSWORD === "string" ? process.env.DSH_GATE_PASSWORD : "";
  if (useGatePassword && gatePassword === "" && root !== null) {
    gatePassword = readEnvFile(path23.join(root, "config", "gate.env")).DSH_GATE_PASSWORD ?? "";
  }
  let token = "";
  if (useGatePassword) {
    token = gatePassword;
  } else {
    token = setting("DSH_INTEROP_TOKEN", "");
    if (token === "" && typeof config.interopToken === "string") token = config.interopToken;
    if (token === "" && existsSync13(tokenFile)) {
      const saved = readFileSync6(tokenFile, "utf8").trim();
      if (saved.length >= 32) token = saved;
    }
    if (token === "") {
      token = randomBytes3(32).toString("hex");
      try {
        mkdirSync2(dataDir, { recursive: true, mode: 448 });
        writeFileSync(tokenFile, `${token}
`, { encoding: "utf8", mode: 384 });
      } catch {
      }
    }
  }
  const configuredPort = Number.parseInt(
    setting("DSH_INTEROP_PORT", String(config.interopPort ?? 8765)),
    10
  );
  const port = Number.isSafeInteger(configuredPort) && configuredPort > 0 ? configuredPort : Number.isSafeInteger(config.interopPort) && config.interopPort > 0 ? config.interopPort : 8765;
  const preset = setting("DSH_INTEROP_PRESET", "workspace-write");
  const agentPreset = setting("DSH_INTEROP_AGENT_PRESET", "standard");
  const reasoning = setting("DSH_INTEROP_REASONING_EFFORT", "");
  const workdir = setting(
    "DSH_WORKDIR",
    root === null ? process.cwd() : path23.join(root, "workspace")
  );
  return {
    file,
    root,
    dataDir,
    tokenFile,
    logFile: path23.join(dataDir, "interop-service.log"),
    stateFile: path23.join(dataDir, "conversations.json"),
    token,
    useGatePassword,
    tokenSource: useGatePassword ? "gate password" : file === null ? "generated token file" : "interop.env",
    bind: setting("DSH_INTEROP_BIND", "127.0.0.1"),
    port,
    provider: setting("DSH_INTEROP_PROVIDER", "deepseek-official"),
    model: setting("DSH_INTEROP_MODEL", "deepseek-flash"),
    reasoningEffort: reasoning === "" ? void 0 : reasoning,
    approve: asBool(setting("DSH_INTEROP_APPROVE", "0"), false),
    preset,
    agentPreset,
    workdir: path23.resolve(workdir),
    // Task workspaces are always below this root, so a workspace name sent by
    // the panel can never address an arbitrary directory on the member.
    workspaceRoot: path23.resolve(setting("DSH_WORKSPACES_DIR", path23.join(homedir3(), ".dsh", "workspaces"))),
    requestTimeoutMs: Number.parseInt(setting("DSH_INTEROP_REQUEST_TIMEOUT_MS", "180000"), 10)
  };
}
function normalizeWorkspaceName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "") return "";
  if (name.length > 120) throw httpError(400, "workspace_invalid", "workspace name is too long");
  if (name === "." || name === ".." || /[\\/"]/u.test(name) || /[\u0000-\u001f]/u.test(name)) {
    throw httpError(400, "workspace_invalid", "workspace name cannot contain a path separator or a quote");
  }
  return name;
}
function workspacePath(settings, name) {
  return path23.join(workspaceRootOf(settings), name);
}
function workspaceRootOf(settings) {
  const root = settings.workspaceRoot;
  return typeof root === "string" && root.trim() !== "" ? path23.resolve(root) : path23.join(homedir3(), ".dsh", "workspaces");
}
function listWorkspaces(settings) {
  const dir = workspaceRootOf(settings);
  try {
    mkdirSync2(dir, { recursive: true });
  } catch {
  }
  const workspaces = [];
  try {
    for (const entry of readdirSync2(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      workspaces.push({ name: entry.name, path: path23.join(dir, entry.name) });
    }
  } catch {
  }
  workspaces.sort((left, right) => left.name.localeCompare(right.name));
  return { dir, workspaces };
}
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}
function fail(response, status, code, message) {
  json(response, status, { ok: false, error: { code, message } });
}
function readJson3(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(httpError(413, "body_too_large", "request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        resolve(value);
      } catch {
        reject(httpError(400, "invalid_json", "request body is not a JSON object"));
      }
    });
    request.on("error", reject);
  });
}
function contentBlocks(value) {
  if (typeof value === "string") {
    if (value.trim() === "") throw httpError(400, "empty_content", "content is empty");
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw httpError(400, "invalid_content", "content must be a string or a non-empty content block array");
  }
  const blocks = value.map((block) => {
    if (block === null || typeof block !== "object") throw httpError(400, "invalid_content", "invalid content block");
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "image" && typeof block.data === "string" && typeof block.mediaType === "string") {
      return { type: "image", data: block.data, mediaType: block.mediaType, ...typeof block.name === "string" ? { name: block.name } : {} };
    }
    if (block.type === "file" && typeof block.receiptId === "string") return { type: "file", receiptId: block.receiptId };
    throw httpError(400, "invalid_content", "unsupported content block");
  });
  if (!blocks.some((block) => block.type !== "text" || block.text.trim() !== "")) {
    throw httpError(400, "empty_content", "content is empty");
  }
  return blocks;
}
function userMessage(blocks) {
  return { id: randomUUID2(), role: "user", content: blocks, source: { kind: "user" } };
}
function createInteropService(options) {
  const ctx = options.ctx;
  const config = options.config ?? {};
  const settings = options.settings ?? resolveInteropSettings(config);
  const logLine = options.log ?? (() => {
  });
  const retry = options.retry !== false;
  const conversations = /* @__PURE__ */ new Map();
  const bySession = /* @__PURE__ */ new Map();
  const handles = /* @__PURE__ */ new Map();
  const listeners = [];
  let server = null;
  let stopped = false;
  let saveTimer = null;
  let saving = false;
  let retryTimer = null;
  let started = false;
  let listening = false;
  mkdirSync2(settings.dataDir, { recursive: true, mode: 448 });
  mkdirSync2(settings.workdir, { recursive: true });
  function log(line) {
    const text = `[interop ${(/* @__PURE__ */ new Date()).toISOString()}] ${line}`;
    try {
      writeFileSync(settings.logFile, `${text}
`, { encoding: "utf8", flag: "a" });
    } catch {
    }
    logLine(text);
  }
  const tokenDigest = settings.token === "" ? null : createHash8("sha256").update(settings.token).digest();
  function authorized(request) {
    if (tokenDigest === null) return false;
    const header = request.headers.authorization ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : String(request.headers["x-dsh-interop-token"] ?? "");
    if (raw === "") return false;
    const digest = createHash8("sha256").update(raw).digest();
    return digest.length === tokenDigest.length && timingSafeEqual2(digest, tokenDigest);
  }
  function publicConversation(conversation) {
    return {
      id: conversation.id,
      sessionId: conversation.sessionId,
      status: conversation.status,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastText: conversation.lastText,
      error: conversation.error,
      eventCount: conversation.events.length,
      cwd: conversation.cwd,
      workspace: conversation.workspace ?? "",
      // The title is capped at 80 characters for the list; the panel's detail
      // view reads the real first prompt from here.
      prompt: conversation.prompt ?? "",
      title: conversation.title ?? "",
      initiator: conversation.initiator ?? null,
      turns: Number.isSafeInteger(conversation.turns) ? conversation.turns : 0,
      replySeq: Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0
    };
  }
  function updateConversation(conversation, patch) {
    Object.assign(conversation, patch, { updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    scheduleSave();
  }
  function wake(conversation) {
    const waiters = conversation.waiters;
    if (!(waiters instanceof Set) || waiters.size === 0) return;
    const parked = [...waiters];
    waiters.clear();
    for (const resolve of parked) {
      try {
        resolve();
      } catch {
      }
    }
  }
  function broadcast(conversation, payload) {
    for (const client of conversation.clients) {
      try {
        client.write(`event: ${payload.type ?? "message"}
data: ${JSON.stringify(payload)}

`);
      } catch {
      }
    }
  }
  function saveState() {
    if (saving) return;
    saving = true;
    try {
      const payload = {
        version: 1,
        savedAt: (/* @__PURE__ */ new Date()).toISOString(),
        conversations: [...conversations.values()].map(conversationRecord)
      };
      const temporary = `${settings.stateFile}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}
`);
      renameSync(temporary, settings.stateFile);
    } catch (error) {
      log(`could not persist conversations: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      saving = false;
    }
  }
  function scheduleSave() {
    if (saveTimer !== null || stopped) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveState();
    }, 500);
    saveTimer.unref?.();
  }
  function loadState() {
    if (!existsSync13(settings.stateFile)) return;
    try {
      const parsed = JSON.parse(readFileSync6(settings.stateFile, "utf8"));
      const records = Array.isArray(parsed?.conversations) ? parsed.conversations : [];
      for (const record of records) {
        if (typeof record?.id !== "string" || conversations.has(record.id)) continue;
        const restored = restoredConversation(record, settings.workdir);
        const conversation = {
          ...restored,
          events: [],
          clients: /* @__PURE__ */ new Set(),
          callbackUrl: "",
          notifiedAt: null,
          replySeq: 0,
          replies: [],
          turnText: "",
          idle: true,
          settledAt: null,
          waiters: /* @__PURE__ */ new Set(),
          prompted: restored.status !== "blank",
          agent: null,
          handle: null,
          failed: restored.status === "error",
          interrupted: restored.status === "interrupted"
        };
        conversations.set(conversation.id, conversation);
        bySession.set(conversation.sessionId, conversation);
      }
      if (conversations.size > 0) log(`restored ${String(conversations.size)} conversation(s) from ${settings.stateFile}`);
    } catch (error) {
      log(`could not restore conversations: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function appendEvent(conversation, event) {
    conversation.events.push(event);
    if (conversation.events.length > MAX_EVENTS) {
      conversation.events.splice(0, conversation.events.length - MAX_EVENTS);
    }
    const reply = applySessionEvent(conversation, event);
    if (event?.type === "turn/start") {
      conversation.idle = false;
      conversation.prompted = true;
      conversation.status = "running";
      conversation.error = null;
      conversation.failed = false;
      conversation.interrupted = false;
    } else if (event?.type === "turn/end") {
      const kind = event?.data?.reason?.kind;
      if (kind === "error") {
        conversation.failed = true;
        conversation.error = conversation.error ?? event?.data?.reason?.error?.message ?? "turn ended with an error";
      } else if (kind === "aborted") {
        conversation.interrupted = true;
        conversation.error = conversation.error ?? "\u5BF9\u8BDD\u88AB\u4E2D\u65AD\u4E86\u3002";
      }
    }
    conversation.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    broadcast(conversation, { type: "session.event", sessionId: conversation.sessionId, event });
    if (reply !== null) wake(conversation);
    scheduleSave();
  }
  function handleAgentStatus(conversation, status) {
    if (status === "running") {
      conversation.idle = false;
      if (conversation.prompted) conversation.status = "running";
      wake(conversation);
      scheduleSave();
      return;
    }
    conversation.idle = true;
    conversation.settledAt = (/* @__PURE__ */ new Date()).toISOString();
    if (!conversation.prompted && conversation.status === "blank") {
      conversation.status = "blank";
    } else if (conversation.interrupted) {
      conversation.status = "interrupted";
    } else if (conversation.failed || conversation.error !== null) {
      conversation.status = "error";
    } else {
      conversation.status = "idle";
    }
    conversation.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    broadcast(conversation, { type: "session.settled", sessionId: conversation.sessionId });
    void notifyCallback(conversation);
    wake(conversation);
    scheduleSave();
  }
  function reconcileStatus(conversation) {
    const agent = conversation.agent;
    if (agent === null || agent === void 0) return;
    if (agent.status === "idle" && conversation.idle !== true) handleAgentStatus(conversation, "idle");
  }
  async function notifyCallback(conversation) {
    if (typeof conversation.callbackUrl !== "string" || conversation.callbackUrl === "") return;
    if (conversation.notifiedAt === conversation.updatedAt) return;
    conversation.notifiedAt = conversation.updatedAt;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1e4);
      timer.unref?.();
      await fetch(conversation.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ conversation: publicConversation(conversation) }),
        signal: controller.signal
      }).finally(() => clearTimeout(timer));
    } catch (error) {
      log(`callback failed for ${conversation.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function findConversation(id) {
    const conversation = conversations.get(id);
    if (conversation === void 0) throw httpError(404, "conversation_not_found", "conversation not found");
    return conversation;
  }
  async function ensureAgent(conversation) {
    const live = typeof ctx.agents?.get === "function" ? ctx.agents.get(conversation.sessionId) : void 0;
    if (live !== void 0) {
      conversation.agent = live;
      return live;
    }
    if (typeof ctx.agents?.resume !== "function") {
      throw httpError(503, "sdk_unavailable", "DSH agent runtime is not available");
    }
    try {
      const composition = await resolveAgentPreset();
      const handle2 = await ctx.agents.resume({
        resumeSessionId: conversation.sessionId,
        ...composition.presets === void 0 || composition.id === "" ? {} : {
          setup: async (agentCtx) => {
            await composition.presets.mount(agentCtx, composition.id);
          }
        }
      });
      handles.set(conversation.id, handle2);
      conversation.handle = handle2;
      conversation.agent = handle2.agent;
      conversation.idle = true;
      return handle2.agent;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw httpError(404, "conversation_not_found", `could not resume the session: ${message}`);
    }
  }
  async function resolveAgentPreset() {
    const presets = typeof ctx.get === "function" ? ctx.get("agentPresets") : void 0;
    if (presets === void 0 || typeof presets.resolve !== "function" || typeof presets.mount !== "function") {
      return { presets: void 0, id: "" };
    }
    try {
      const resolved = await presets.resolve(settings.agentPreset === "" ? void 0 : settings.agentPreset);
      return { presets, id: typeof resolved?.id === "string" ? resolved.id : "" };
    } catch (error) {
      log(`could not resolve agent preset ${settings.agentPreset}: ${error instanceof Error ? error.message : String(error)}`);
      return { presets: void 0, id: "" };
    }
  }
  function applyPreset(agent) {
    const presets = typeof ctx.get === "function" ? ctx.get("permissionPresets") : void 0;
    if (presets === void 0 || typeof presets.set !== "function" || settings.preset === "") return;
    try {
      presets.set(agent.session, settings.preset);
    } catch (error) {
      log(`could not apply preset ${settings.preset} to ${String(agent?.id ?? "")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function appendTitle(conversation) {
    if (conversation.title === "" || conversation.agent === null) return;
    try {
      conversation.agent.session.append([["session/title", {
        title: conversation.title,
        messageSeqs: [],
        source: { kind: "user" }
      }]]);
    } catch (error) {
      log(`could not title ${conversation.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function createConversation(request) {
    if (typeof ctx.agents?.create !== "function") {
      throw httpError(503, "sdk_unavailable", "DSH agent runtime is not available");
    }
    const id = randomUUID2();
    const workspace = normalizeWorkspaceName(request.workspace);
    const cwd = workspace !== "" ? workspacePath(settings, workspace) : typeof request.cwd === "string" && request.cwd !== "" ? path23.resolve(request.cwd) : settings.workdir;
    const prompt = request.prompt;
    try {
      mkdirSync2(cwd, { recursive: true });
    } catch {
    }
    const conversation = {
      id,
      sessionId: id,
      cwd,
      workspace,
      prompt: promptText(prompt),
      title: normalizeTitle(request.title) || titleFromPrompt(prompt),
      initiator: normalizeInitiator(request.initiator),
      status: prompt === void 0 ? "blank" : "running",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastText: "",
      error: null,
      events: [],
      clients: /* @__PURE__ */ new Set(),
      callbackUrl: typeof request.callbackUrl === "string" ? request.callbackUrl : "",
      notifiedAt: null,
      turns: 0,
      replySeq: 0,
      replies: [],
      turnText: "",
      idle: false,
      settledAt: null,
      waiters: /* @__PURE__ */ new Set(),
      prompted: prompt !== void 0,
      agent: null,
      handle: null,
      failed: false,
      interrupted: false
    };
    conversations.set(id, conversation);
    bySession.set(id, conversation);
    const composition = await resolveAgentPreset();
    let handle2 = null;
    try {
      handle2 = await ctx.agents.create({
        sessionId: id,
        // Record the resolved identity in the session header as well as mounting
        // it below; the Web's resume path reads the header.
        meta: { cwd, ...composition.id === "" ? {} : { agentPreset: composition.id } },
        agentOptions: {
          provider: settings.provider,
          model: settings.model,
          ...settings.reasoningEffort === void 0 ? {} : { reasoningEffort: settings.reasoningEffort }
        },
        setup: async (agentCtx, agent) => {
          if (composition.presets !== void 0 && composition.id !== "") {
            await composition.presets.mount(agentCtx, composition.id);
          }
          applyPreset(agent);
        }
      });
      handles.set(id, handle2);
      conversation.handle = handle2;
      conversation.agent = handle2.agent;
      appendTitle(conversation);
      if (prompt !== void 0) {
        handle2.agent.followup(userMessage(contentBlocks(prompt)));
        conversation.status = "running";
        conversation.idle = false;
      }
      scheduleSave();
      return conversation;
    } catch (error) {
      conversations.delete(id);
      bySession.delete(id);
      if (handle2 !== null) {
        handles.delete(id);
        await Promise.resolve(handle2.dispose()).catch(() => {
        });
      }
      throw error;
    }
  }
  async function sendMessage(conversation, request) {
    const blocks = contentBlocks(request.content ?? request.message ?? request.prompt);
    const agent = await ensureAgent(conversation);
    conversation.prompted = true;
    conversation.status = "running";
    conversation.idle = false;
    conversation.error = null;
    conversation.failed = false;
    conversation.interrupted = false;
    conversation.notifiedAt = null;
    if (request.callbackUrl !== void 0) conversation.callbackUrl = String(request.callbackUrl);
    agent.followup(userMessage(blocks));
    conversation.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    broadcast(conversation, { type: "message.accepted", sessionId: conversation.sessionId, ok: true });
    scheduleSave();
    return { accepted: true };
  }
  function nextSignal(conversation, ms) {
    if (!(conversation.waiters instanceof Set)) conversation.waiters = /* @__PURE__ */ new Set();
    return new Promise((resolve) => {
      let timer;
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        conversation.waiters.delete(waiter);
        resolve();
      }, Math.max(0, ms));
      timer.unref?.();
      conversation.waiters.add(waiter);
    });
  }
  function turnsOf(conversation) {
    return Number.isSafeInteger(conversation.turns) ? conversation.turns : 0;
  }
  function seqOf(conversation) {
    return Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0;
  }
  async function waitUntilSettled(conversation, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (conversation.idle !== true) {
      const left = deadline - Date.now();
      if (left <= 0) return { timedOut: true, state: "running", settled: false };
      await nextSignal(conversation, left);
    }
    return {
      timedOut: false,
      state: "done",
      settled: true,
      text: conversation.lastText ?? "",
      turn: turnsOf(conversation),
      seq: seqOf(conversation),
      replies: []
    };
  }
  async function waitForReply(conversation, timeoutMs, since) {
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      const replies = repliesSince(conversation, since);
      if (replies.length > 0) {
        let settled = conversation.idle === true;
        if (!settled) {
          const left2 = Math.min(SETTLE_MS, Math.max(0, deadline - Date.now()));
          if (left2 > 0) {
            await nextSignal(conversation, left2);
            settled = conversation.idle === true;
          }
        }
        const summary = summarizeReplies(replies);
        return {
          timedOut: false,
          state: settled ? "done" : "progress",
          settled,
          text: summary.text,
          turn: summary.turn ?? turnsOf(conversation),
          seq: summary.seq ?? seqOf(conversation),
          replies
        };
      }
      if (conversation.idle === true) {
        return {
          timedOut: false,
          state: "done",
          settled: true,
          text: "",
          turn: turnsOf(conversation),
          seq: seqOf(conversation),
          replies: []
        };
      }
      if (conversation.interrupted || conversation.failed || conversation.error !== null) {
        return {
          timedOut: false,
          state: "done",
          settled: true,
          text: "",
          turn: turnsOf(conversation),
          seq: seqOf(conversation),
          replies: []
        };
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return {
          timedOut: true,
          state: "running",
          settled: false,
          text: "",
          turn: turnsOf(conversation),
          seq: seqOf(conversation),
          replies: []
        };
      }
      await nextSignal(conversation, left);
    }
  }
  async function waitConversation(conversation, timeoutMs, since) {
    reconcileStatus(conversation);
    if (conversation.interrupted && conversation.error !== null) {
      return { timedOut: false, state: "done", settled: true, text: conversation.lastText ?? "", turn: turnsOf(conversation), seq: seqOf(conversation), replies: [] };
    }
    if (!Number.isSafeInteger(since) || since < 0) return waitUntilSettled(conversation, timeoutMs);
    if (conversation.idle !== true) await ensureAgent(conversation).catch((error) => {
      conversation.interrupted = true;
      conversation.error = error instanceof Error ? error.message : String(error);
      conversation.idle = true;
      wake(conversation);
    });
    return waitForReply(conversation, timeoutMs, since);
  }
  async function clearFinished() {
    let removed = 0;
    for (const [id, conversation] of [...conversations]) {
      if (conversation.status === "running") continue;
      conversations.delete(id);
      bySession.delete(conversation.sessionId);
      const handle2 = handles.get(id);
      handles.delete(id);
      if (handle2 !== void 0) await Promise.resolve(handle2.dispose()).catch(() => {
      });
      removed += 1;
    }
    saveState();
    return removed;
  }
  async function serveSystem(response, url) {
    const sampleMs = Number.parseInt(url.searchParams.get("sampleMs") ?? "200", 10);
    const system = await collectSystemInfo({ sampleMs: Number.isSafeInteger(sampleMs) ? sampleMs : 200 });
    const section = url.pathname.split("/")[3] ?? "";
    if (section === "") {
      json(response, 200, { ok: true, system });
      return;
    }
    const key = section === "disk" ? "disks" : section;
    if (key === "cpu" || key === "memory" || key === "disks" || key === "network" || key === "process") {
      json(response, 200, { ok: true, sampledAt: system.sampledAt, [key]: system[key] });
      return;
    }
    fail(response, 404, "not_found", "Unknown system information section.");
  }
  async function handle(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://interop.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, {
          ok: true,
          service: "dsh-interop",
          mode: "embedded",
          engine: EMBEDDED_INTEROP_MARKER,
          sdk: "ready",
          conversations: conversations.size
        });
        return;
      }
      if (!authorized(request)) {
        fail(response, 401, "unauthorized", "A bearer token is required.");
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/workspaces") {
        const listing = listWorkspaces(settings);
        json(response, 200, { ok: true, dir: listing.dir, workspaces: listing.workspaces });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/v1/system" || url.pathname.startsWith("/v1/system/"))) {
        await serveSystem(response, url);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        json(response, 200, { ok: true, conversations: [...conversations.values()].map(publicConversation) });
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/v1/conversations") {
        const removed = await clearFinished();
        log(`cleared ${String(removed)} conversation(s)`);
        json(response, 200, { ok: true, removed });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        const body = await readJson3(request);
        const conversation2 = await createConversation(body);
        json(response, 201, { ok: true, conversation: publicConversation(conversation2) });
        return;
      }
      const match = /^\/v1\/conversations\/([^/]+)(?:\/(messages|notify|wait|events|result))?$/u.exec(url.pathname);
      if (match === null) {
        fail(response, 404, "not_found", "Unknown endpoint.");
        return;
      }
      const conversation = findConversation(decodeURIComponent(match[1]));
      const suffix = match[2] ?? "";
      if (request.method === "GET" && suffix === "") {
        reconcileStatus(conversation);
        json(response, 200, { ok: true, conversation: publicConversation(conversation) });
        return;
      }
      if (request.method === "GET" && suffix === "result") {
        reconcileStatus(conversation);
        json(response, 200, { ok: true, conversation: publicConversation(conversation), finalText: conversation.lastText });
        return;
      }
      if (request.method === "GET" && suffix === "events") {
        const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
        const once = url.searchParams.get("once") === "1";
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        response.write(`event: ready
data: ${JSON.stringify({ conversation: publicConversation(conversation), since })}

`);
        for (const event of conversation.events) {
          if (typeof event?.seq === "number" && event.seq < since) continue;
          response.write(`event: session.event
data: ${JSON.stringify(event)}

`);
        }
        if (once) {
          response.end();
          return;
        }
        conversation.clients.add(response);
        const heartbeat = setInterval(() => {
          try {
            response.write(": ping\n\n");
          } catch {
          }
        }, 15e3);
        heartbeat.unref?.();
        request.once("close", () => {
          clearInterval(heartbeat);
          conversation.clients.delete(response);
        });
        return;
      }
      if (request.method === "POST" && (suffix === "messages" || suffix === "notify")) {
        const body = await readJson3(request);
        const receipt = await sendMessage(conversation, body);
        json(response, 202, { ok: true, conversation: publicConversation(conversation), receipt });
        return;
      }
      if (request.method === "POST" && suffix === "wait") {
        const body = await readJson3(request).catch(() => ({}));
        const timeoutMs = Number.isSafeInteger(body.timeoutMs) ? Math.max(1e3, Math.min(body.timeoutMs, 6e5)) : 3e4;
        const since = Number.isSafeInteger(body.since) ? body.since : void 0;
        const result = await waitConversation(conversation, timeoutMs, since);
        json(response, 200, {
          ok: true,
          timedOut: result.timedOut === true,
          state: result.state ?? "done",
          settled: result.settled === true,
          text: typeof result.text === "string" ? result.text : "",
          turn: Number.isSafeInteger(result.turn) ? result.turn : turnsOf(conversation),
          seq: Number.isSafeInteger(result.seq) ? result.seq : seqOf(conversation),
          replies: Array.isArray(result.replies) ? result.replies : [],
          conversation: publicConversation(conversation)
        });
        return;
      }
      fail(response, 405, "method_not_allowed", "Unsupported method for this endpoint.");
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = typeof error?.code === "string" ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) log(`request failed: ${message}`);
      fail(response, status, code, message);
    }
  }
  function attachListeners() {
    if (typeof ctx.on !== "function") return;
    if (settings.approve) {
      listeners.push(ctx.on("approval/request", (request, next) => {
        try {
          if (request?.agent?.id !== void 0 && conversations.has(request.agent.id)) {
            return Promise.resolve("allowed-once");
          }
        } catch {
        }
        return next();
      }, { prepend: true }));
    }
    listeners.push(ctx.on("session/event", (session, event) => {
      if (session?.id === void 0 || event === void 0) return;
      const conversation = bySession.get(String(session.id));
      if (conversation !== void 0) appendEvent(conversation, event);
    }));
    listeners.push(ctx.on("agent/status", (payload) => {
      const id = payload?.agent?.id;
      if (id === void 0) return;
      const conversation = conversations.get(String(id));
      if (conversation !== void 0) handleAgentStatus(conversation, payload.status === "running" ? "running" : "idle");
    }));
    listeners.push(ctx.on("agent/disposed", (payload) => {
      const id = payload?.agent?.id;
      if (id === void 0) return;
      const conversation = conversations.get(String(id));
      if (conversation === void 0) return;
      if (conversation.status === "running") {
        conversation.interrupted = true;
        conversation.error = conversation.error ?? INTERRUPTED_ERROR;
      }
      conversation.agent = null;
      conversation.handle = null;
      conversation.idle = true;
      if (conversation.prompted) {
        conversation.status = conversation.interrupted ? "interrupted" : conversation.error !== null ? "error" : "idle";
      }
      conversation.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      wake(conversation);
      scheduleSave();
    }));
  }
  async function dispose() {
    if (stopped) return;
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (saveTimer !== null) clearTimeout(saveTimer);
    for (const off of listeners.splice(0)) {
      try {
        off?.();
      } catch {
      }
    }
    for (const conversation of conversations.values()) {
      if (conversation.status === "running") {
        conversation.status = "interrupted";
        conversation.interrupted = true;
        conversation.error = conversation.error ?? INTERRUPTED_ERROR;
        conversation.idle = true;
        conversation.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
    }
    saveState();
    for (const [id, handle2] of [...handles]) {
      handles.delete(id);
      await Promise.resolve(handle2.dispose()).catch(() => {
      });
    }
    await new Promise((resolve) => {
      if (server === null) {
        resolve();
        return;
      }
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
      setTimeout(resolve, 2e3).unref?.();
    });
    server = null;
    listening = false;
  }
  function listen() {
    return new Promise((resolve, reject) => {
      const current = http3.createServer((request, response) => {
        void handle(request, response);
      });
      current.on("error", (error) => {
        const code = error?.code;
        if (!stopped && retry && (code === "EADDRINUSE" || code === "EADDRNOTAVAIL" || code === "EACCES")) {
          log(`listen on ${settings.bind}:${String(settings.port)} failed (${String(code)}); retrying in 5s`);
          try {
            current.close();
          } catch {
          }
          retryTimer = setTimeout(() => {
            retryTimer = null;
            listen().then(resolve, reject);
          }, 5e3);
          retryTimer.unref?.();
          return;
        }
        reject(error);
      });
      current.listen(settings.port, settings.bind, () => {
        server = current;
        listening = true;
        const address = current.address();
        const port = typeof address === "object" && address !== null ? address.port : settings.port;
        log(`listening on http://${settings.bind}:${String(port)} (embedded; token source ${settings.tokenSource})`);
        resolve({ port });
      });
    });
  }
  return {
    settings,
    /** Start the listener and host listeners. */
    async start() {
      if (started) return { port: settings.port };
      started = true;
      loadState();
      attachListeners();
      return listen();
    },
    /** Stop the listener, dispose agents, and persist status. */
    dispose,
    /** Public conversations, for tests and diagnostics. */
    conversations,
    /** Whether the listener is currently bound. */
    get listening() {
      return listening;
    }
  };
}

// src/index.ts
var inject = ["webServer"];
function dataDirectory() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path24.join(homedir4(), ".dsh");
  return path24.join(home, "mesh");
}
async function apply(ctx, config = {}) {
  const service = new MeshService({
    dataDir: dataDirectory(),
    config,
    log: (line) => console.log(line)
  });
  ctx.effect(() => () => {
    void service.dispose();
  }, "mesh service lifetime");
  const scheduler = new Scheduler({
    service,
    file: scheduleFile(dataDirectory()),
    // Auto-upgrade is configured per member; the scheduler needs the current
    // ids to apply the default 06:00 entry to members without an override.
    members: async () => {
      const snapshot = await service.members();
      return [snapshot.local?.id, ...snapshot.members.map((member) => member.id)].filter((id) => typeof id === "string" && id !== "");
    },
    log: (line) => console.log(`mesh schedule: ${line}`)
  });
  ctx.effect(() => () => scheduler.dispose(), "mesh schedule lifetime");
  registerApi(ctx, service, scheduler);
  registerWireGuardApi(ctx);
  try {
    ctx.inject(["tools"], (toolsCtx) => {
      registerTools(ctx, toolsCtx, service);
    });
  } catch (error) {
    console.error(`mesh: tools service is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.interopEmbedded !== false) {
    try {
      ctx.inject(["agents"], (agentsCtx) => {
        let settings;
        try {
          settings = resolveInteropSettings(config);
        } catch (error) {
          console.error(`mesh interop: could not resolve settings: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        const interop = createInteropService({
          ctx: agentsCtx,
          settings,
          config,
          log: (line) => console.log(line)
        });
        agentsCtx.effect(() => () => {
          void interop.dispose();
        }, "mesh embedded interop lifetime");
        void interop.start().catch((error) => {
          console.error(`mesh interop: listener failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
    } catch (error) {
      console.error(`mesh: agent registry is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
export {
  apply,
  inject
};
