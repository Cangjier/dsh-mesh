// src/index.ts
import { homedir as homedir4 } from "node:os";
import path32 from "node:path";

// src/lib/service.mjs
import { mkdir as mkdir15, readFile as readFile18, readdir as readdir9, rm as rm15, stat as stat13, writeFile as writeFile15 } from "node:fs/promises";
import { existsSync as existsSync14, readFileSync as readFileSync5, realpathSync } from "node:fs";
import { execFile as execFile3, spawn as spawn7 } from "node:child_process";
import { createHash as createHash8 } from "node:crypto";
import os10 from "node:os";
import path27 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { promisify as promisify3 } from "node:util";

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
import { existsSync, readFileSync } from "node:fs";
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
  const pointerRoot = existsSync(path3.join(root, "dsh-mesh.json")) ? root : path3.basename(path3.dirname(root)) === "releases" ? path3.dirname(path3.dirname(root)) : root;
  const pointer = readJson(path3.join(pointerRoot, "dsh-mesh.json"));
  const active = typeof pointer?.active === "string" && pointer.active !== "" ? pointer.active : "";
  const resolved = active === "" ? root : path3.isAbsolute(active) ? active : path3.join(pointerRoot, active);
  const manifest = readJson(path3.join(resolved, "manifest.json"));
  const plugin = manifest === null ? readJson(path3.join(resolved, "plugins", "dsh-mesh", "package.json")) : null;
  const manifestVersion = typeof manifest?.version === "string" && manifest.version.trim() !== "" ? manifest.version.trim() : null;
  const pluginVersion = typeof plugin?.version === "string" && plugin.version.trim() !== "" ? plugin.version.trim() : null;
  return {
    version: manifestVersion ?? pluginVersion,
    buildStamp: typeof manifest?.buildStamp === "string" && manifest.buildStamp.trim() !== "" ? manifest.buildStamp.trim() : null,
    builtAt: typeof manifest?.builtAt === "string" && manifest.builtAt.trim() !== "" ? manifest.builtAt.trim() : null,
    release: active === "" ? null : path3.basename(resolved),
    layout: "pointer",
    target: manifest?.target !== null && typeof manifest?.target === "object" ? manifest.target : null
  };
}

// code/build/job.mjs
import { appendFile as appendFile2, mkdir as mkdir9, readFile as readFile11, rename as rename6, rm as rm10, stat as stat8, writeFile as writeFile8 } from "node:fs/promises";
import { existsSync as existsSync8 } from "node:fs";
import { randomBytes } from "node:crypto";
import os8 from "node:os";
import path15 from "node:path";

// code/build/engine.mjs
import { spawn as spawn2 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { createWriteStream as createWriteStream2, existsSync as existsSync5 } from "node:fs";
import { chmod as chmod3, cp as cp2, mkdir as mkdir3, open as open2, readFile as readFile6, readdir as readdir3, rename as rename2, rm as rm3, stat as stat3, writeFile as writeFile3 } from "node:fs/promises";
import { Readable as Readable2 } from "node:stream";
import { pipeline as pipeline2 } from "node:stream/promises";
import os4 from "node:os";
import path8 from "node:path";

// code/build/archive.mjs
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import os2 from "node:os";
import path4 from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { createGzip } from "node:zlib";
var MIN_CHUNK = 2 * 1024 * 1024;
var MAX_CHUNK = 32 * 1024 * 1024;
var BLOCK = 512;
var DEFAULT_LEVEL = 6;
function archiveThreads(options = {}) {
  const env = options.env ?? process.env;
  const requested = Number(env.DSH_MESH_ARCHIVE_THREADS);
  if (Number.isSafeInteger(requested) && requested > 0) return Math.min(8, requested);
  const cpus = Number(options.cpus) || os2.availableParallelism?.() || os2.cpus().length || 1;
  return Math.max(1, Math.min(8, cpus));
}
function run(command, args, options = {}) {
  const log = options.log ?? (() => {
  });
  const tail = [];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: null, tail: [error instanceof Error ? error.message : String(error)] });
      return;
    }
    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line === "") continue;
        tail.push(line);
        if (tail.length > 80) tail.shift();
        log(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => resolve({ ok: false, code: null, tail: [...tail, String(error)] }));
    child.on("close", (code) => resolve({ ok: code === 0, code, tail }));
  });
}
async function createTar(packageDir, tarPath, options = {}) {
  await rm(tarPath, { force: true });
  const result = await run("tar", ["-cf", tarPath, "-C", path4.dirname(packageDir), path4.basename(packageDir)], options);
  if (!result.ok) throw new Error(`cannot create ${tarPath}: ${result.tail.join("\n")}`);
}
function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}
function parseOctal(field) {
  const text = field.toString("ascii").replace(/\0.*$/u, "").trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}
function patchHeader(header) {
  header.write("0000755\0", 100, 8, "ascii");
  header.fill(32, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}
function patchChunk(chunk, state) {
  let offset = 0;
  while (offset + BLOCK <= chunk.length) {
    if (state.dataLeft > 0) {
      const take = Math.min(state.dataLeft, chunk.length - offset);
      offset += take;
      state.dataLeft -= take;
      continue;
    }
    const header = chunk.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      offset += BLOCK;
      continue;
    }
    patchHeader(header);
    state.dataLeft = Math.ceil(parseOctal(header.subarray(124, 136)) / BLOCK) * BLOCK;
    offset += BLOCK;
  }
}
var COMPRESS_WORKER = `
const { parentPort } = require('node:worker_threads')
const { gzipSync } = require('node:zlib')
parentPort.on('message', message => {
  const input = Buffer.from(message.chunk)
  const compressed = gzipSync(input, { level: message.level })
  const exact = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength)
  parentPort.postMessage({ seq: message.seq, chunk: exact }, [exact])
})
`;
async function gzipParallel(options) {
  const log = options.log ?? (() => {
  });
  const info = await stat(options.source);
  const level = Number.isSafeInteger(options.level) ? options.level : DEFAULT_LEVEL;
  const wanted = Math.max(1, Math.min(options.threads, Math.floor(info.size / MIN_CHUNK) || 1));
  const threads = Math.max(1, Math.min(wanted, 8));
  const chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.ceil(info.size / threads / BLOCK) * BLOCK));
  await rm(options.destination, { force: true });
  const input = await open(options.source, "r");
  const output = await open(options.destination, "w");
  const workers = [];
  const idle = [];
  const waiting = [];
  const acquire = () => idle.length > 0 ? Promise.resolve(idle.pop()) : new Promise((resolve) => waiting.push(resolve));
  const release = (worker) => {
    const next = waiting.shift();
    if (next !== void 0) next(worker);
    else idle.push(worker);
  };
  let seqDispatched = 0;
  const compressed = /* @__PURE__ */ new Map();
  let nextWrite = 0;
  let written = 0;
  let drainChain = Promise.resolve();
  let failure = null;
  let received = 0;
  let settle = null;
  const finished2 = new Promise((resolve) => {
    settle = resolve;
  });
  const maybeSettled = () => {
    if (received === seqDispatched && nextWrite === received) settle?.();
  };
  const writeAll = async (buffer) => {
    let done = 0;
    while (done < buffer.length) {
      const result = await output.write(buffer, done, buffer.length - done);
      if (result.bytesWritten <= 0) throw new Error(`cannot write ${options.destination}`);
      done += result.bytesWritten;
    }
  };
  const drain3 = () => {
    drainChain = drainChain.then(async () => {
      while (compressed.has(nextWrite)) {
        const buffer = compressed.get(nextWrite);
        compressed.delete(nextWrite);
        await writeAll(buffer);
        written += buffer.length;
        nextWrite += 1;
        maybeSettled();
      }
    }).catch((error) => {
      failure = failure ?? (error instanceof Error ? error : new Error(String(error)));
      waiting.splice(0).forEach((resolve) => resolve(null));
    });
    return drainChain;
  };
  try {
    for (let index = 0; index < threads; index += 1) {
      const worker = new Worker(COMPRESS_WORKER, { eval: true });
      worker.on("message", (message) => {
        compressed.set(message.seq, Buffer.from(message.chunk));
        received += 1;
        release(worker);
        void drain3();
        maybeSettled();
      });
      worker.on("error", (error) => {
        failure = failure ?? (error instanceof Error ? error : new Error(String(error)));
        log(`compression worker failed: ${failure.message}`);
        waiting.splice(0).forEach((resolve) => resolve(null));
      });
      idle.push(worker);
      workers.push(worker);
    }
    const state = { dataLeft: 0 };
    let offset = 0;
    while (offset < info.size) {
      const length = Math.min(chunkSize, info.size - offset);
      const buffer = Buffer.allocUnsafeSlow(length);
      let filled = 0;
      while (filled < length) {
        const read = await input.read(buffer, filled, length - filled, offset + filled);
        if (read.bytesRead === 0) break;
        filled += read.bytesRead;
      }
      if (filled < length) throw new Error(`short read from ${options.source} at ${String(offset)}: ${String(filled)} of ${String(length)} bytes`);
      if (options.patchModes === true) patchChunk(buffer, state);
      const worker = await acquire();
      if (worker === null) throw failure ?? new Error("compression worker failed");
      worker.postMessage({ seq: seqDispatched, chunk: buffer.buffer, level }, [buffer.buffer]);
      seqDispatched += 1;
      offset += filled;
    }
    await finished2;
    await drain3();
    if (failure !== null) throw failure;
    if (nextWrite !== seqDispatched) {
      throw new Error(`compression lost chunks: wrote ${String(nextWrite)} of ${String(seqDispatched)}`);
    }
    await output.sync();
  } finally {
    await output.close().catch(() => {
    });
    await input.close().catch(() => {
    });
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {
    })));
  }
  return { members: nextWrite, bytes: written };
}
async function gzipSingle(source, destination, patchModes) {
  const steps = [createReadStream(source)];
  if (patchModes) {
    const state = { dataLeft: 0, remainder: Buffer.alloc(0) };
    steps.push(new Transform({
      transform(chunk, _encoding, callback) {
        state.remainder = Buffer.concat([state.remainder, chunk]);
        const usable = state.remainder.length - state.remainder.length % BLOCK;
        if (usable > 0) {
          const body = state.remainder.subarray(0, usable);
          patchChunk(body, state);
          this.push(body);
          state.remainder = state.remainder.subarray(usable);
        }
        callback();
      },
      flush(callback) {
        if (state.remainder.length > 0) this.push(state.remainder);
        callback();
      }
    }));
  }
  steps.push(createGzip({ level: DEFAULT_LEVEL }), createWriteStream(destination));
  await pipeline(...steps);
  return { members: 1, bytes: (await stat(destination)).size };
}
async function createSevenZip(options) {
  const log = options.log ?? (() => {
  });
  const level = Number.isSafeInteger(options.level) ? options.level : Number(process.env.DSH_MESH_7Z_LEVEL ?? 0) || 5;
  const threads = Math.max(1, Number(options.threads) || 1);
  await rm(options.destination, { force: true });
  const args = [
    "a",
    "-t7z",
    `-mx=${Math.max(0, Math.min(9, level))}`,
    `-mmt=${threads}`,
    "-bd",
    "-snl",
    options.destination,
    "*"
  ];
  log(`7z ${args.slice(0, 5).join(" ")} ${path4.basename(options.destination)}`);
  const result = await run(options.binary, args, { cwd: options.packageDir, log });
  if (!result.ok) throw new Error(`7z could not create ${options.destination}: ${result.tail.join("\n")}`);
  const info = await stat(options.destination);
  if (!info.isFile() || info.size <= 0) throw new Error(`7z created no usable archive: ${options.destination}`);
  return { bytes: info.size };
}
async function createTarGz(options) {
  const log = options.log ?? (() => {
  });
  const tarPath = `${options.destination}.tar`;
  const threads = Math.max(1, Number(options.threads) || 1);
  try {
    log(`creating tar for ${path4.basename(options.packageDir)}`);
    await createTar(options.packageDir, tarPath, { log });
    const size = (await stat(tarPath)).size;
    if (threads <= 1 || size < MIN_CHUNK) {
      return await gzipSingle(tarPath, options.destination, options.patchModes === true);
    }
    const started = Date.now();
    const result = await gzipParallel({
      source: tarPath,
      destination: options.destination,
      threads,
      patchModes: options.patchModes === true,
      log
    });
    log(`compressed ${path4.basename(options.destination)} on ${String(threads)} threads (${String(result.members)} gzip members, ${String(Math.max(1, Math.round((Date.now() - started) / 1e3)))}s)`);
    return result;
  } finally {
    await rm(tarPath, { force: true }).catch(() => {
    });
  }
}

// code/shared/sevenzip.mjs
import { existsSync as existsSync2 } from "node:fs";
import { chmod, readFile as readFile3 } from "node:fs/promises";
import path5 from "node:path";
var SEVEN_ZIP_SUFFIX = ".7z";
var SEVEN_ZIP_ASSET_NAME = "7z";
function sevenZipAssetFile(os11, arch = "x64") {
  const text = String(os11 ?? "").toLowerCase();
  if (text.startsWith("win")) return "7za-windows-x64.exe";
  return arch === "arm64" ? "7zz-linux-arm64" : "7zz-linux-x64";
}
function resolveSevenZipAssetPath(repositoryRoot, os11, arch = "x64") {
  const file = sevenZipAssetFile(os11, arch);
  const roots = [
    path5.join(repositoryRoot, "code", "gate", "assets", SEVEN_ZIP_ASSET_NAME),
    path5.join(repositoryRoot, "gate", "assets", SEVEN_ZIP_ASSET_NAME),
    path5.join(repositoryRoot, "..", "gate", "assets", SEVEN_ZIP_ASSET_NAME),
    path5.join(repositoryRoot, "..", "..", "gate", "assets", SEVEN_ZIP_ASSET_NAME)
  ];
  for (const root of roots) {
    const candidate = path5.join(root, file);
    if (existsSync2(candidate)) return candidate;
  }
  return path5.join(roots[0], file);
}
function hostSevenZipPlatform() {
  return {
    os: process.platform === "win32" ? "windows" : "linux",
    arch: process.arch === "arm64" ? "arm64" : "x64"
  };
}
function hostSevenZipPath(repositoryRoot) {
  const { os: os11, arch } = hostSevenZipPlatform();
  return resolveSevenZipAssetPath(repositoryRoot, os11, arch);
}
async function ensureSevenZipBinary(file) {
  if (!existsSync2(file)) {
    throw new Error(
      `7-Zip binary is missing: ${file}
The package must carry code/gate/assets/7z/ (a package built before the 7z switch has no copy); rebuild or copy the asset, then retry.`
    );
  }
  if (process.platform !== "win32") {
    try {
      await chmod(file, 493);
    } catch {
    }
  }
  return file;
}
function isSevenZipArchive(file) {
  return String(file ?? "").toLowerCase().endsWith(SEVEN_ZIP_SUFFIX);
}

// code/build/cache.mjs
import { createHash } from "node:crypto";
import { existsSync as existsSync3 } from "node:fs";
import { cp, lstat, link, mkdir as mkdir2, readFile as readFile4, readdir, readlink, rename, rm as rm2, stat as stat2, symlink, chmod as chmod2, writeFile as writeFile2 } from "node:fs/promises";
import os3 from "node:os";
import path6 from "node:path";
var WEB_CACHE_FORMAT = 2;
var WEB_CACHE_KEEP = 4;
var APP_CACHE_KEEP = 3;
function targetSlug(target) {
  return String(target).trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "_");
}
function appCacheDir(cacheDir, version, target) {
  const versionSlug = String(version).trim().replace(/[^A-Za-z0-9._+-]+/gu, "_");
  return path6.join(cacheDir, "app", `${versionSlug}-${targetSlug(target)}`);
}
function appCacheMetaFile(cacheDir, version, target) {
  return `${appCacheDir(cacheDir, version, target)}.json`;
}
function webCacheDir(cacheDir, key) {
  return path6.join(cacheDir, "web", key);
}
async function hashTree(dir, hash, root = dir) {
  if (!existsSync3(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = path6.join(dir, entry.name);
    if (entry.isDirectory()) {
      await hashTree(full, hash, root);
      continue;
    }
    if (!entry.isFile()) continue;
    hash.update(`\0file:${path6.relative(root, full).split(path6.sep).join("/")}\0`);
    hash.update(await readFile4(full));
  }
}
async function webBuildCacheKey(options) {
  const sourcePinned = typeof options.archiveSha256 === "string" && options.archiveSha256 !== "";
  if (!sourcePinned) return null;
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    format: WEB_CACHE_FORMAT,
    platform: `${process.platform}-${process.arch}`,
    node: process.versions.node,
    source: options.source ?? null,
    archiveSha256: options.archiveSha256,
    prepare: options.prepare ?? null,
    install: options.install ?? null,
    build: options.build ?? null,
    prebuild: options.prebuild !== false
  }));
  if (typeof options.recipesFile === "string" && existsSync3(options.recipesFile)) {
    hash.update("\0recipes\0");
    hash.update(await readFile4(options.recipesFile));
  }
  hash.update("\0overlays\0");
  await hashTree(options.overlayRoot ?? "", hash);
  return hash.digest("hex");
}
async function readWebCache(cacheDir, key) {
  const dir = webCacheDir(cacheDir, key);
  const dist = path6.join(dir, "dist");
  if (!existsSync3(path6.join(dist, "index.html"))) return null;
  let meta = {};
  try {
    meta = JSON.parse(await readFile4(path6.join(dir, "meta.json"), "utf8"));
  } catch {
  }
  return { dist, meta };
}
async function writeWebCache(options) {
  const log = options.log ?? (() => {
  });
  const dir = webCacheDir(options.cacheDir, options.key);
  const staging = `${dir}.tmp-${String(process.pid)}`;
  try {
    await rm2(staging, { recursive: true, force: true });
    await mkdir2(staging, { recursive: true });
    await cp(options.dist, path6.join(staging, "dist"), { recursive: true });
    await writeFile2(path6.join(staging, "meta.json"), JSON.stringify({
      ...options.meta,
      key: options.key,
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2), "utf8");
    await rm2(dir, { recursive: true, force: true });
    await rename(staging, dir);
    await pruneWebCache(options.cacheDir, WEB_CACHE_KEEP, log);
    return true;
  } catch (error) {
    log(`web build cache write failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
    await rm2(staging, { recursive: true, force: true }).catch(() => {
    });
    return false;
  }
}
async function pruneWebCache(cacheDir, keep = WEB_CACHE_KEEP, log = () => {
}) {
  const root = path6.join(cacheDir, "web");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path6.join(root, entry.name);
    try {
      dirs.push({ full, mtime: (await stat2(full)).mtimeMs });
    } catch {
    }
  }
  dirs.sort((left, right) => right.mtime - left.mtime);
  for (const stale of dirs.slice(keep)) {
    await rm2(stale.full, { recursive: true, force: true }).catch(() => {
    });
    log(`pruned web build cache ${path6.basename(stale.full)}`);
  }
}
async function readAppCache(cacheDir, version, target) {
  const dir = appCacheDir(cacheDir, version, target);
  const metaFile = appCacheMetaFile(cacheDir, version, target);
  if (!existsSync3(path6.join(dir, "node_modules", "@deepseek-ai", "dsh", "package.json"))) return null;
  try {
    const meta = JSON.parse(await readFile4(metaFile, "utf8"));
    if (meta.complete !== true) return null;
    if (meta.version !== version || meta.target !== target) return null;
    return meta;
  } catch {
    return null;
  }
}
async function writeAppCacheMeta(options) {
  const log = options.log ?? (() => {
  });
  await mkdir2(path6.join(options.cacheDir, "app"), { recursive: true });
  await writeFile2(appCacheMetaFile(options.cacheDir, options.version, options.target), JSON.stringify({
    ...options.meta,
    version: options.version,
    target: options.target,
    complete: true,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  }, null, 2), "utf8");
  await pruneAppCache(options.cacheDir, APP_CACHE_KEEP, options.target, options.version, log);
}
async function pruneAppCache(cacheDir, keep = APP_CACHE_KEEP, currentTarget = "", currentVersion = "", log = () => {
}) {
  const root = path6.join(cacheDir, "app");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path6.join(root, entry.name);
    try {
      dirs.push({ full, mtime: (await stat2(full)).mtimeMs });
    } catch {
    }
  }
  dirs.sort((left, right) => right.mtime - left.mtime);
  const keepDir = appCacheDir(cacheDir, currentVersion, currentTarget);
  const survivors = new Set(dirs.slice(0, keep).map((entry) => entry.full));
  survivors.add(keepDir);
  for (const entry of dirs) {
    if (survivors.has(entry.full)) continue;
    await rm2(entry.full, { recursive: true, force: true }).catch(() => {
    });
    await rm2(`${entry.full}.json`, { force: true }).catch(() => {
    });
    log(`pruned app cache ${path6.basename(entry.full)}`);
  }
}
var CLONE_CONCURRENCY = 24;
function semaphore(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit) return;
    const job = waiting.shift();
    if (job === void 0) return;
    void job();
  };
  return async (fn) => {
    const run3 = () => {
      active += 1;
      return fn().finally(() => {
        active -= 1;
        next();
      });
    };
    if (active < limit) return run3();
    return new Promise((resolve, reject) => {
      waiting.push(() => {
        run3().then(resolve, reject);
      });
    });
  };
}
async function cloneTree(from, to, options = {}) {
  const log = options.log ?? (() => {
  });
  await rm2(to, { recursive: true, force: true });
  const counts = { linked: 0, copied: 0, symlinked: 0 };
  const run3 = semaphore(CLONE_CONCURRENCY);
  const cloneEntry = async (source, destination) => {
    const info = await run3(() => lstat(source));
    if (info.isDirectory()) {
      await run3(() => mkdir2(destination, { recursive: true }));
      const entries = await run3(() => readdir(source));
      await Promise.all(entries.map((name) => cloneEntry(path6.join(source, name), path6.join(destination, name))));
      return;
    }
    if (info.isSymbolicLink()) {
      const target = await run3(() => readlink(source));
      await run3(() => symlink(target, destination));
      counts.symlinked += 1;
      return;
    }
    if (!info.isFile()) return;
    try {
      await run3(() => link(source, destination));
      counts.linked += 1;
      return;
    } catch {
      await run3(() => cp(source, destination, { preserveTimestamps: true }));
      try {
        await run3(() => chmod2(destination, info.mode & 511));
      } catch {
      }
      counts.copied += 1;
    }
  };
  await cloneEntry(from, to);
  log(`cloned app tree: ${String(counts.linked)} linked, ${String(counts.copied)} copied, ${String(counts.symlinked)} symlinks`);
  return counts;
}
function cachesDisabled(env = process.env) {
  const value = String(env.DSH_MESH_NO_CACHE ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
function packagingConcurrency(options = {}) {
  const targets = Math.max(1, Number(options.targets) || 1);
  if (targets === 1) return 1;
  const requested = Number(options.requested);
  if (Number.isSafeInteger(requested) && requested > 0) return Math.min(targets, requested);
  const env = options.env ?? process.env;
  const fromEnv = Number(env.DSH_MESH_CONCURRENCY);
  if (Number.isSafeInteger(fromEnv) && fromEnv > 0) return Math.min(targets, fromEnv);
  const cpus = Number(options.cpus) || os3.availableParallelism?.() || os3.cpus().length || 1;
  const memory = Number(options.totalMemBytes) || os3.totalmem();
  if (memory < 6 * 1024 ** 3) return 1;
  return Math.min(targets, Math.max(1, Math.floor(cpus / 4)));
}

// code/build/static-assets.mjs
import { existsSync as existsSync4 } from "node:fs";
import { readFile as readFile5, readdir as readdir2 } from "node:fs/promises";
import path7 from "node:path";
var NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
var FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
var SHA256_PATTERN = /^[0-9a-f]{64}$/u;
async function collectStaticAssets(gateDirectory) {
  const assetsDirectory = path7.join(gateDirectory, "assets");
  if (!existsSync4(assetsDirectory)) return [];
  const directories = await readdir2(assetsDirectory, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      const manifestPath = path7.join(assetsDirectory, directory.name, "manifest.json");
      const raw = JSON.parse(await readFile5(manifestPath, "utf8"));
      const entries = Array.isArray(raw.assets) ? raw.assets : typeof raw.file === "string" ? [{ os: "windows", arch: "x64", file: raw.file, sha256: raw.sha256, bytes: raw.bytes }] : [];
      const assets = [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const file = typeof entry.file === "string" ? entry.file : "";
        const sha256 = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : "";
        const bytes = Number(entry.bytes);
        if (!FILE_PATTERN.test(file) || !SHA256_PATTERN.test(sha256)) continue;
        if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
        if (!existsSync4(path7.join(assetsDirectory, directory.name, file))) continue;
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
function defaultCacheDir() {
  return path8.join(os4.homedir(), ".dsh", "mesh", "cache");
}
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
  const hash = createHash2("sha256");
  const handle = await open2(file, "r");
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
  return createHash2("sha256").update(text).digest("hex");
}
function parseTarget(target) {
  const [os11, arch] = String(target).split("-");
  if (!["linux", "win", "darwin"].includes(os11)) throw new Error(`unsupported target OS: ${target}`);
  if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported target architecture: ${target}`);
  return { os: os11, arch, libc: os11 === "linux" ? "glibc" : "" };
}
function classifySource(source) {
  const value = String(source).trim().replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");
  if (existsSync5(value)) return { kind: "local", dir: path8.resolve(value) };
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
  if (existsSync5(file) && (await stat3(file)).size > 0) return true;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {
  });
  log(`GET ${url}`);
  const response = await fetchImpl(url, { redirect: "follow" });
  if (response.status === 404) return false;
  if (!response.ok || response.body === null) throw new Error(`download failed: ${url} -> HTTP ${String(response.status)}`);
  await mkdir3(path8.dirname(file), { recursive: true });
  const temporary = `${file}.part`;
  await pipeline2(Readable2.fromWeb(response.body), createWriteStream2(temporary));
  await rename2(temporary, file);
  return true;
}
function runCommand(command, args, options = {}) {
  const log = options.log ?? (() => {
  });
  const tail = [];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn2(command, args, {
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
  await rm3(destination, { recursive: true, force: true });
  await mkdir3(destination, { recursive: true });
  if (archive.toLowerCase().endsWith(".zip") && process.platform !== "win32") {
    const temporary = `${destination}.zip-tmp`;
    await rm3(temporary, { recursive: true, force: true });
    await mkdir3(temporary, { recursive: true });
    const unzipped = await runCommand("unzip", ["-q", archive, "-d", temporary], { log: options.log });
    if (!unzipped.ok) {
      throw new Error(`cannot extract ${archive}: ${unzipped.error?.message ?? `unzip exited with ${String(unzipped.code)}`}
${unzipped.tail.join("\n")}`);
    }
    const entries = await readdir3(temporary);
    const first = entries[0];
    const wrapped = entries.length === 1 && first !== void 0 && (await stat3(path8.join(temporary, first))).isDirectory();
    const content = wrapped ? path8.join(temporary, first) : temporary;
    await rm3(destination, { recursive: true, force: true });
    await cp2(content, destination, { recursive: true });
    await rm3(temporary, { recursive: true, force: true });
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
  const cacheDir = options.cacheDir ?? path8.join(os4.homedir(), ".dsh", "mesh", "cache");
  const urls = tarballUrls(classified, ref);
  const archive = path8.join(cacheDir, "sources", `${sha256Text(`${classified.owner}/${classified.repo}@${ref}`).slice(0, 16)}.tar.gz`);
  const etagFile = `${archive}.etag`;
  const immutable = /^[0-9a-f]{40}$/iu.test(ref);
  const remoteEtag = immutable ? null : await remoteRevision(source, ref, { fetchImpl: options.fetchImpl, log });
  let cachedEtag = "";
  if (!immutable && existsSync5(etagFile)) {
    try {
      cachedEtag = (await readFile6(etagFile, "utf8")).trim();
    } catch {
      cachedEtag = "";
    }
  }
  if (!immutable && existsSync5(archive)) {
    const age = Date.now() - (await stat3(archive)).mtimeMs;
    const staleContent = remoteEtag !== null && cachedEtag !== remoteEtag;
    if (staleContent || age > (options.maxCacheAgeMs ?? 6 * 60 * 6e4)) {
      log(staleContent ? `refreshing cached tarball for ${ref} (remote content changed)` : `refreshing cached tarball for ${ref} (older than the cache window)`);
      await rm3(archive, { force: true });
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
      await writeFile3(etagFile, `${remoteEtag}
`, "utf8");
    } catch {
    }
  }
  const archiveSha256 = await sha256File(archive);
  const dir = path8.join(options.workDir, "src");
  log(`extracting ${path8.basename(archive)} to ${dir}`);
  await extractTarball(archive, dir, { log });
  return { dir, source, ref, local: false, archive, archiveSha256, archiveEtag: remoteEtag };
}
async function loadRecipes(file) {
  const parsed = JSON.parse(await readFile6(file, "utf8"));
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
      const target = path8.join(options.dir, entry.path);
      const overlay = path8.join(options.overlayRoot, entry.overlay);
      const label = { step: step.id, title: step.title, doc: step.doc, path: entry.path };
      if (!existsSync5(overlay)) {
        mismatches.push({ ...label, reason: "overlay file is missing", expected: entry.baseSha256 ?? null, actual: null });
        continue;
      }
      let current = null;
      try {
        current = await readFile6(target, "utf8");
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
      await mkdir3(path8.dirname(target), { recursive: true });
      await cp2(overlay, target);
      const written = await readFile6(target, "utf8");
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
  await mkdir3(options.dir, { recursive: true });
  const jobDir = options.jobDir ?? options.dir;
  const jsonPath = path8.join(options.dir, "work-order.json");
  const markdownPath = path8.join(options.dir, "work-order.md");
  const promptPath = path8.join(options.dir, "subagent-prompt.txt");
  const prompt = [
    `\u4F60\u5728\u4E3A dsh-mesh \u6784\u5EFA ${options.source}@${options.ref} \u7684\u4FEE\u6539\u7248 Web \u5305\u3002`,
    "\u786E\u5B9A\u6027\u6784\u5EFA\u5728\u5E94\u7528\u6E90\u7801\u8986\u76D6\u5C42\u65F6\u5931\u8D25\u3002\u8BF7\u53EA\u4FEE\u590D\u5DE5\u4F5C\u6811\u91CC\u7684\u6E90\u7801\uFF0C\u4E0D\u8981\u653E\u5BBD\u8986\u76D6\u5C42\u6821\u9A8C\u3002",
    "\u5148\u8BFB work-order.md \u4E0E\u5BF9\u5E94\u7684 Step \u6587\u6863\uFF0C\u518D\u4FEE\u6539\u4E0B\u5217\u6587\u4EF6\uFF0C\u4F7F\u6BCF\u4E2A\u6587\u4EF6\u7684\u8986\u76D6\u5C42 marker \u5B58\u5728\uFF0C\u5E76\u8BA9 pnpm run build:web \u901A\u8FC7\u3002",
    `\u4FEE\u5B8C\u540E\u8C03\u7528 dsh-mesh \u7684 build \u5DE5\u5177\uFF0C\u5E76\u4F20 jobId="${path8.basename(jobDir)}"\uFF1B\u5B83\u4F1A\u81EA\u52A8\u628A\u4FEE\u6539\u56FA\u5316\u6210\u8986\u76D6\u5C42\u5E76\u7EE7\u7EED\u540C\u4E00\u4E2A job\u3002`,
    "",
    ...options.result.mismatches.map((item) => `- ${item.path}\uFF08${item.step}\uFF1B${item.doc}\uFF09\uFF1A${item.reason}`)
  ].join("\n");
  const markdown = [
    `# \u6784\u5EFA\u5DE5\u4F5C\u5355\uFF1A${options.source}@${options.ref}`,
    "",
    `- \u6E90\u7801\u6811\uFF1A\`${options.worktree ?? path8.join(jobDir, "src")}\``,
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
    `3. \u8C03\u7528 build \u5DE5\u5177\uFF0C\u53C2\u6570 \`jobId="${path8.basename(jobDir)}"\`\uFF1B\u5B83\u4F1A\u628A\u6539\u597D\u7684\u6587\u4EF6\u5199\u56DE \`build/overlays/\`\u3002`,
    "4. \u540C\u4E00\u6B21 build \u8C03\u7528\u4F1A\u590D\u7528\u5DE5\u4F5C\u6811\u7EE7\u7EED install/build/package\uFF1B\u4E0B\u4E00\u6B21\u540C\u4E00 ref \u4F1A\u76F4\u63A5\u5E94\u7528\u65B0\u8986\u76D6\u5C42\u3002",
    "",
    "## \u5EFA\u8BAE\u7684\u5B50\u4EE3\u7406\u63D0\u793A\u8BCD",
    "",
    "```text",
    prompt,
    "```"
  ].join("\n");
  await writeFile3(jsonPath, JSON.stringify({
    source: options.source,
    ref: options.ref,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    jobDir,
    worktree: options.worktree ?? path8.join(jobDir, "src"),
    mismatches: options.result.mismatches
  }, null, 2), "utf8");
  await writeFile3(markdownPath, markdown, "utf8");
  await writeFile3(promptPath, prompt, "utf8");
  return { json: jsonPath, markdown: markdownPath, prompt: promptPath };
}
async function learnOverlays(options) {
  const learned = [];
  const actualByPath = new Map(
    (options.mismatches ?? []).filter((item) => typeof item.actual === "string" && /^[0-9a-f]{64}$/u.test(item.actual)).map((item) => [item.path, item.actual])
  );
  for (const step of options.recipes.steps) {
    for (const entry of step.files ?? []) {
      const source = path8.join(options.worktree, entry.path);
      let text;
      try {
        text = await readFile6(source, "utf8");
      } catch {
        throw new Error(`cannot learn ${entry.path}: the file is missing from the worktree`);
      }
      if (!text.includes(entry.marker)) {
        throw new Error(`cannot learn ${entry.path}: the overlay marker "${entry.marker}" is missing`);
      }
      const target = path8.join(options.overlayRoot, entry.overlay);
      await mkdir3(path8.dirname(target), { recursive: true });
      await writeFile3(target, text, "utf8");
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
    const packageDir = path8.join(options.dir, "packages", "experimental", name.replace("@deepseek-ai/dsh-experimental-", ""));
    if (!existsSync5(packageDir)) {
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
  const cacheDir = typeof options.cacheDir === "string" && options.cacheDir !== "" ? options.cacheDir : null;
  const cacheKey = typeof options.cacheKey === "string" && options.cacheKey !== "" ? options.cacheKey : null;
  if (cacheDir !== null && cacheKey !== null && options.refreshCache !== true) {
    const cached = await readWebCache(cacheDir, cacheKey);
    if (cached !== null) {
      log(`web build cache hit ${cacheKey.slice(0, 12)}: skipping pnpm install and the web build`);
      await progress("build", 62);
      return { ok: true, dist: cached.dist, cached: true };
    }
  }
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
    path8.join(options.dir, "apps", "web", "dist"),
    path8.join(options.dir, "dist")
  ];
  for (const candidate of candidates) {
    if (!existsSync5(path8.join(candidate, "index.html"))) continue;
    if (cacheDir !== null && cacheKey !== null) {
      await writeWebCache({
        cacheDir,
        key: cacheKey,
        dist: candidate,
        meta: options.cacheMeta ?? {},
        log
      });
    }
    return { ok: true, dist: candidate, cached: false };
  }
  return { ok: false, dist: null, error: "the build finished but no dist/index.html was found" };
}
async function copyIfExists(from, to) {
  if (!existsSync5(from)) return;
  await mkdir3(path8.dirname(to), { recursive: true });
  await cp2(from, to, { recursive: true });
}
async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir3(current, { withFileTypes: true })) {
      const full = path8.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path8.relative(dir, full));
    }
  }
  if (existsSync5(dir)) await walk(dir);
  return out;
}
var PLUGIN_FINGERPRINT_FILES = [
  "package.json",
  "index.js",
  "client.js",
  "cordis.patch.yml",
  "icon.svg",
  "VERSION",
  "start-interop.sh",
  "install-interop-service.sh",
  "uninstall-interop-service.sh",
  "install.sh",
  "install.ps1",
  // The stable launcher and its pointer live at the layout root; a package
  // that lacks them cannot be installed in the pointer layout.
  "dsh-mesh.mjs"
];
var PLUGIN_FINGERPRINT_DIRS = ["locale", "build", "docs", "code"];
async function pluginFingerprint(repositoryRoot) {
  const files = [];
  for (const name of PLUGIN_FINGERPRINT_FILES) {
    if (existsSync5(path8.join(repositoryRoot, name))) files.push(name);
  }
  for (const dir of PLUGIN_FINGERPRINT_DIRS) {
    for (const rel of await listFiles(path8.join(repositoryRoot, dir))) files.push(path8.join(dir, rel));
  }
  files.sort();
  const hash = createHash2("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await sha256File(path8.join(repositoryRoot, rel)));
    hash.update("\n");
  }
  return hash.digest("hex");
}
async function readExtraPlugins(repositoryRoot) {
  const file = path8.join(repositoryRoot, "build", "plugins.json");
  if (!existsSync5(file)) return [];
  const parsed = JSON.parse(await readFile6(file, "utf8"));
  const list = parsed !== null && typeof parsed === "object" && Array.isArray(parsed.plugins) ? parsed.plugins : [];
  return list.filter((entry) => entry !== null && typeof entry === "object").map((entry) => ({
    name: typeof entry.name === "string" ? entry.name.trim() : "",
    dir: typeof entry.dir === "string" && entry.dir.trim() !== "" ? entry.dir.trim() : "",
    repo: typeof entry.repo === "string" ? entry.repo.trim() : "",
    ref: typeof entry.ref === "string" && entry.ref.trim() !== "" ? entry.ref.trim() : "main"
  })).filter((entry) => entry.name !== "" && entry.repo !== "").map((entry) => ({ ...entry, dir: entry.dir !== "" ? entry.dir : path8.join("plugins", entry.name) }));
}
var extraPluginsGate = Promise.resolve();
async function copyExtraPlugins(options) {
  const run3 = extraPluginsGate.then(() => copyExtraPluginsOnce(options));
  extraPluginsGate = run3.then(() => {
  }, () => {
  });
  return run3;
}
async function copyExtraPluginsOnce(options) {
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
    const archive = path8.join(cacheDir, "plugins", `${plugin.name}.tar.gz`);
    await mkdir3(path8.dirname(archive), { recursive: true });
    await rm3(archive, { force: true });
    let downloaded = false;
    for (const url of tarballUrls(classified, plugin.ref)) {
      downloaded = await download(url, archive, { fetchImpl: options.fetchImpl, log });
      if (downloaded) break;
    }
    if (!downloaded) {
      throw new Error(`cannot download extra plugin ${plugin.name} from ${plugin.repo}@${plugin.ref}`);
    }
    const tree = path8.join(cacheDir, "plugins", `${plugin.name}-tree`);
    await rm3(tree, { recursive: true, force: true });
    await extractTarball(archive, tree, { log });
    const target = path8.join(options.packageDir, plugin.dir);
    await rm3(target, { recursive: true, force: true });
    await mkdir3(path8.dirname(target), { recursive: true });
    await cp2(tree, target, { recursive: true });
    await rm3(tree, { recursive: true, force: true });
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
  const packageDir = path8.join(options.outputDir, `dsh-mesh-${identity}-${targetOs2}-${arch}`);
  await rm3(packageDir, { recursive: true, force: true });
  await mkdir3(path8.join(packageDir, "web"), { recursive: true });
  await cp2(options.dist, path8.join(packageDir, "web"), { recursive: true });
  await copyIfExists(path8.join(options.repositoryRoot, "code", "gate"), path8.join(packageDir, "gate"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "shared"), path8.join(packageDir, "shared"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "shared"), path8.join(packageDir, "code", "shared"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "config"), path8.join(packageDir, "config"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "windows-service"), path8.join(packageDir, "code", "windows-service"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "interop-service"), path8.join(packageDir, "code", "interop-service"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "wireguard"), path8.join(packageDir, "code", "wireguard"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "dsh-service"), path8.join(packageDir, "code", "dsh-service"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "deploy"), path8.join(packageDir, "code", "deploy"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "install"), path8.join(packageDir, "code", "install"));
  await copyIfExists(path8.join(options.repositoryRoot, "dsh-mesh.mjs"), path8.join(packageDir, "dsh-mesh.mjs"));
  await copyIfExists(path8.join(options.repositoryRoot, "docs"), path8.join(packageDir, "docs"));
  for (const file of ["install.sh", "install.ps1", "VERSION"]) {
    await copyIfExists(path8.join(options.repositoryRoot, "code", file), path8.join(packageDir, file));
  }
  for (const file of ["start-interop.sh", "install-interop-service.sh", "uninstall-interop-service.sh"]) {
    await copyIfExists(path8.join(options.repositoryRoot, file), path8.join(packageDir, file));
  }
  for (const file of ["index.js", "client.js", "cordis.patch.yml", "package.json"]) {
    await copyIfExists(path8.join(options.repositoryRoot, file), path8.join(packageDir, "plugins", "dsh-mesh", file));
  }
  await copyIfExists(path8.join(options.repositoryRoot, "locale"), path8.join(packageDir, "plugins", "dsh-mesh", "locale"));
  await copyIfExists(path8.join(options.repositoryRoot, "build"), path8.join(packageDir, "plugins", "dsh-mesh", "build"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "build"), path8.join(packageDir, "plugins", "dsh-mesh", "code", "build"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "shared"), path8.join(packageDir, "plugins", "dsh-mesh", "code", "shared"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "deploy"), path8.join(packageDir, "plugins", "dsh-mesh", "code", "deploy"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "install"), path8.join(packageDir, "plugins", "dsh-mesh", "code", "install"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "gate", "assets", "7z"), path8.join(packageDir, "plugins", "dsh-mesh", "code", "gate", "assets", "7z"));
  const extraPlugins = await copyExtraPlugins({
    packageDir,
    repositoryRoot: options.repositoryRoot,
    cacheDir: options.cacheDir,
    fetchImpl: options.fetchImpl,
    log: options.log
  });
  const staticAssets = await collectStaticAssets(path8.join(options.repositoryRoot, "code", "gate"));
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
  await writeFile3(path8.join(packageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { packageDir, manifest };
}
async function archivePackage(packageDir, target, options = {}) {
  const { os: targetOs2 } = parseTarget(target);
  const requested = String(options.format ?? process.env.DSH_MESH_ARCHIVE_FORMAT ?? "7z").trim().toLowerCase();
  const format = requested === "legacy" ? targetOs2 === "win" ? "zip" : "tar.gz" : requested;
  if (format !== "7z" && format !== "zip" && format !== "tar.gz" && format !== "tgz") {
    throw new Error(`unknown archive format: ${requested} (use 7z, legacy, tar.gz, or zip)`);
  }
  if (format !== "7z" && format !== "zip" && targetOs2 === "win") {
    throw new Error(`a Windows package must be 7z or zip, not ${format}`);
  }
  const extension = format === "7z" ? SEVEN_ZIP_SUFFIX : format === "zip" ? ".zip" : ".tar.gz";
  const archive = `${packageDir}${extension}`;
  await rm3(archive, { force: true });
  options.log?.(`archiving ${target}`);
  if (format === "7z") {
    if (typeof options.repositoryRoot !== "string" || options.repositoryRoot === "") {
      throw new Error("7z archiving needs repositoryRoot: the bundled 7z binary lives under code/gate/assets/7z");
    }
    try {
      const binary = await ensureSevenZipBinary(hostSevenZipPath(options.repositoryRoot));
      const started = Date.now();
      const result = await createSevenZip({
        packageDir,
        destination: archive,
        binary,
        threads: options.threads ?? archiveThreads({ env: options.env }),
        log: options.log
      });
      options.log?.(`archived ${target}: ${(result.bytes / 1e6).toFixed(1)} MB 7z in ${Math.max(1, Math.round((Date.now() - started) / 1e3))}s`);
      return archive;
    } catch (error) {
      throw new Error(`cannot archive ${packageDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (format === "zip") {
    let result;
    if (process.platform !== "win32") {
      result = await runCommand("zip", ["-qr", archive, path8.basename(packageDir)], {
        cwd: path8.dirname(packageDir),
        log: options.log
      });
    } else {
      result = await runCommand("tar", ["-a", "-c", "-f", archive, "-C", path8.dirname(packageDir), path8.basename(packageDir)], {
        log: options.log
      });
    }
    if (!result.ok) throw new Error(`cannot archive ${packageDir}: ${result.tail.join("\n")}`);
    return archive;
  }
  try {
    await createTarGz({
      packageDir,
      destination: archive,
      // On a Windows host the tar header modes are wrong for a Linux target;
      // patching them is part of the streaming compressor now.
      patchModes: process.platform === "win32",
      threads: options.threads ?? archiveThreads({ env: options.env }),
      log: options.log
    });
  } catch (error) {
    throw new Error(`cannot archive ${packageDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  const archive = path8.join(options.cacheDir, "node", archiveName);
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
    if (!existsSync5(path8.join(options.destination, "node.exe"))) throw new Error("Node archive did not contain node.exe");
  } else {
    const node = path8.join(options.destination, "bin", "node");
    if (!existsSync5(node)) throw new Error("Node archive did not contain bin/node");
    await chmod3(node, 493);
  }
  return { directory: options.destination, archive, sha256: actual };
}
async function installAppDependencies(options) {
  const parsed = parseTarget(options.target);
  const log = options.log ?? (() => {
  });
  await mkdir3(options.appDir, { recursive: true });
  await writeFile3(path8.join(options.appDir, "package.json"), JSON.stringify({
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
  return { appDir: options.appDir, nodeModules: path8.join(options.appDir, "node_modules") };
}
async function overlayFrontend(options) {
  const log = options.log ?? (() => {
  });
  const frontend = path8.join(options.appDir, "node_modules", "@deepseek-ai", "dsh-web-frontend");
  const packageFile = path8.join(frontend, "package.json");
  if (!existsSync5(packageFile)) {
    throw new Error(`cannot find @deepseek-ai/dsh-web-frontend under ${options.appDir}`);
  }
  const target = path8.join(frontend, "dist");
  await rm3(target, { recursive: true, force: true });
  await cp2(options.dist, target, { recursive: true });
  if (!existsSync5(path8.join(target, "index.html"))) {
    throw new Error("the built web frontend has no index.html after the copy");
  }
  log(`frontend installed at ${target}`);
  return target;
}
async function inspectShellSeedTable(distDir) {
  const index = path8.join(distDir, "index.html");
  if (!existsSync5(index)) return null;
  const html = await readFile6(index, "utf8");
  const sources = [...html.matchAll(/<script[^>]+src="\.?\/?([^"]+\.js)"/gu)].map((match) => match[1]);
  for (const relative of sources) {
    const file = path8.join(distDir, relative);
    if (!existsSync5(file)) continue;
    const text = await readFile6(file, "utf8");
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
  const root = path8.join(appDir, "node_modules", "@deepseek-ai", "dsh-client-modules");
  const file = path8.join(root, "lib", "client.js");
  if (!existsSync5(file)) return null;
  const text = await readFile6(file, "utf8");
  let version = null;
  try {
    version = JSON.parse(await readFile6(path8.join(root, "package.json"), "utf8")).version ?? null;
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
  const scope = path8.join(appDir, "node_modules", "@deepseek-ai");
  if (!existsSync5(scope)) return null;
  const entries = await readdir3(scope, { withFileTypes: true }).catch(() => []);
  const pattern = new RegExp(`\\.${exportName}\\b`, "u");
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "dsh-client-ui-primitives" || entry.name === "dsh-client-modules") continue;
    const file = path8.join(scope, entry.name, "lib", "client.js");
    if (!existsSync5(file)) continue;
    const text = await readFile6(file, "utf8").catch(() => "");
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
    const published = path8.join(options.appDir, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist");
    if (!existsSync5(path8.join(published, "index.html"))) throw error;
    log("keeping the published frontend from app/ (its client bundles match by construction); the UI overlays still apply through patchInstalledClient");
    await checkFrontendAppContract({ appDir: options.appDir, dist: published, log });
    return { source: "published", dist: published, reason };
  }
}
async function patchInstalledClient(options) {
  const log = options.log ?? (() => {
  });
  const picker = path8.join(
    options.appDir,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-directory-picker-browse",
    "lib",
    "client.js"
  );
  const login = path8.join(
    options.appDir,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-settings-account",
    "lib",
    "client.js"
  );
  for (const file of [picker, login]) {
    if (!existsSync5(file)) throw new Error(`installed client bundle is missing: ${file}`);
  }
  const steps = [
    { file: picker, script: path8.join(options.repositoryRoot, "code", "gate", "patch-picker.mjs"), marker: "dsh-picker-patched" },
    { file: login, script: path8.join(options.repositoryRoot, "code", "gate", "patch-login.mjs"), marker: "dsh-gate-account-login" }
  ];
  for (const step of steps) {
    log(`patching ${path8.basename(path8.dirname(path8.dirname(step.file)))} client bundle`);
    const result = await runCommand(process.execPath, [step.script, step.file], {
      cwd: options.repositoryRoot,
      log,
      timeoutMs: 12e4
    });
    if (!result.ok) throw new Error(`client bundle patch failed: ${step.script}
${result.tail.join("\n")}`);
    const text = await readFile6(step.file, "utf8");
    if (!text.includes(step.marker)) throw new Error(`client bundle patch did not leave its marker: ${step.file}`);
    await rm3(`${step.file}.orig`, { force: true });
  }
  return { picker, login };
}
var APP_CACHE_FORMAT = 1;
async function patchBundleFingerprint(repositoryRoot) {
  const hash = createHash2("sha256");
  hash.update(`format:${String(APP_CACHE_FORMAT)}`);
  for (const name of ["patch-picker.mjs", "patch-login.mjs"]) {
    hash.update(`\0${name}\0`);
    try {
      hash.update(await readFile6(path8.join(repositoryRoot, "code", "gate", name)));
    } catch {
      hash.update("missing");
    }
  }
  return hash.digest("hex");
}
async function ensureAppCache(options) {
  const log = options.log ?? (() => {
  });
  if (typeof options.cacheDir !== "string" || options.cacheDir === "") {
    throw new Error("ensureAppCache needs a cacheDir");
  }
  const patchFingerprint = await patchBundleFingerprint(options.repositoryRoot);
  if (options.refresh !== true) {
    const cached = await readAppCache(options.cacheDir, options.version, options.target);
    if (cached !== null && cached.patchFingerprint === patchFingerprint) {
      log(`app cache hit ${options.target} (@deepseek-ai/dsh@${options.version})`);
      return { dir: appCacheDir(options.cacheDir, options.version, options.target), meta: cached, cached: true };
    }
    if (cached !== null) log(`app cache stale ${options.target}: the client patch scripts changed; reinstalling`);
  }
  const dir = appCacheDir(options.cacheDir, options.version, options.target);
  log(`app cache miss ${options.target}: installing @deepseek-ai/dsh@${options.version}`);
  await rm3(dir, { recursive: true, force: true });
  await rm3(appCacheMetaFile(options.cacheDir, options.version, options.target), { force: true });
  await installAppDependencies({
    appDir: dir,
    version: options.version,
    target: options.target,
    env: options.env,
    log
  });
  await patchInstalledClient({ appDir: dir, repositoryRoot: options.repositoryRoot, log });
  const meta = {
    format: APP_CACHE_FORMAT,
    version: options.version,
    target: options.target,
    patchFingerprint,
    installedAt: (/* @__PURE__ */ new Date()).toISOString(),
    npm: process.env.npm_config_user_agent ?? null,
    node: process.versions.node
  };
  await writeAppCacheMeta({
    cacheDir: options.cacheDir,
    version: options.version,
    target: options.target,
    meta,
    log
  });
  log(`app cache stored ${options.target}`);
  return { dir, meta, cached: false };
}
async function materializeApp(options) {
  const log = options.log ?? (() => {
  });
  if (typeof options.cacheDir !== "string" || options.cacheDir === "") {
    await installAppDependencies({
      appDir: options.appDir,
      version: options.version,
      target: options.target,
      env: options.env,
      log
    });
    await patchInstalledClient({ appDir: options.appDir, repositoryRoot: options.repositoryRoot, log });
    return { cached: false, meta: null };
  }
  const cached = await ensureAppCache({ ...options, log });
  await cloneTree(cached.dir, options.appDir, { log });
  return { cached: true, meta: cached.meta };
}
async function assembleRuntimePackage(options) {
  const log = options.log ?? (() => {
  });
  const { packageDir, manifest } = await assembleWebPackage(options);
  const appDir = path8.join(packageDir, "app");
  const app = await materializeApp({
    // `appCacheDir` lets a build disable the app cache while still using
    // `cacheDir` for the Node runtime and the extra plugin tarballs.
    cacheDir: options.appCacheDir === void 0 ? options.cacheDir : options.appCacheDir,
    version: options.dshVersion,
    target: options.target,
    appDir,
    repositoryRoot: options.repositoryRoot,
    env: options.env,
    log,
    refresh: options.refreshAppCache
  });
  const frontend = await chooseFrontend({ appDir, dist: options.dist, log });
  if (frontend.source === "built") {
    await overlayFrontend({ appDir, dist: frontend.dist, log });
  } else {
    const web = path8.join(packageDir, "web");
    await rm3(web, { recursive: true, force: true });
    await cp2(frontend.dist, web, { recursive: true });
  }
  log(`node runtime ${options.target}`);
  await installNodeRuntime({
    version: options.nodeVersion,
    target: options.target,
    cacheDir: options.cacheDir,
    destination: path8.join(packageDir, "runtime", "node"),
    fetchImpl: options.fetchImpl,
    log
  });
  await copyIfExists(path8.join(options.repositoryRoot, "code", "install.sh"), path8.join(packageDir, "install.sh"));
  await copyIfExists(path8.join(options.repositoryRoot, "code", "install.ps1"), path8.join(packageDir, "install.ps1"));
  await writeFile3(path8.join(packageDir, ".offline-payload"), "dsh-mesh\n", "utf8");
  await writeFile3(path8.join(packageDir, "VERSION"), `${options.dshVersion}
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
    // Where the installed app came from: the cache (the version and target
    // were installed before) or a fresh npm install during this build.
    app: { source: app.cached ? "cache" : "npm", installedAt: app.meta?.installedAt ?? null },
    files: (await listFiles(packageDir)).length
  };
  await writeFile3(path8.join(packageDir, "manifest.json"), JSON.stringify(updated, null, 2), "utf8");
  return { packageDir, manifest: updated };
}

// code/build/smoke.mjs
import { spawn as spawn4 } from "node:child_process";
import { accessSync, constants, existsSync as existsSync7 } from "node:fs";
import { appendFile, copyFile, mkdir as mkdir6, mkdtemp as mkdtemp3, readFile as readFile8, rm as rm7, symlink as symlink3, writeFile as writeFile5 } from "node:fs/promises";
import net from "node:net";
import os6 from "node:os";
import path12 from "node:path";

// code/shared/chrome.mjs
import { spawn as spawn3 } from "node:child_process";
import { existsSync as existsSync6 } from "node:fs";
import { mkdtemp, readFile as readFile7, rm as rm4 } from "node:fs/promises";
import { tmpdir } from "node:os";
import path9 from "node:path";
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
    if (existsSync6(file)) return;
    if (signal?.aborted === true) throw new Error(`aborted waiting for ${path9.basename(file)}`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 120);
      timer.unref?.();
    });
  }
  throw new Error(`timed out waiting for ${path9.basename(file)}`);
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
    session.#profileDir = await mkdtemp(path9.join(tmpdir(), "dsh-chrome-"));
    session.#child = spawn3(binary, [
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
    const portFile = path9.join(session.#profileDir, "DevToolsActivePort");
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
    const [port, wsPath] = (await readFile7(portFile, "utf8")).split("\n");
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
      rm4(this.#profileDir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
};

// code/build/chrome-download.mjs
import { createWriteStream as createWriteStream4 } from "node:fs";
import { chmod as chmod5, mkdir as mkdir5, mkdtemp as mkdtemp2, readdir as readdir4, rename as rename3, rm as rm6, stat as stat5 } from "node:fs/promises";
import os5 from "node:os";
import path11 from "node:path";
import { Readable as Readable3 } from "node:stream";
import { pipeline as pipeline4 } from "node:stream/promises";

// code/build/zip.mjs
import { createReadStream as createReadStream2, createWriteStream as createWriteStream3 } from "node:fs";
import { chmod as chmod4, mkdir as mkdir4, open as open3, rm as rm5, stat as stat4, symlink as symlink2, writeFile as writeFile4 } from "node:fs/promises";
import path10 from "node:path";
import { pipeline as pipeline3 } from "node:stream/promises";
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
  const root = path10.resolve(destination);
  const target = path10.resolve(root, ...segments);
  if (target !== root && !target.startsWith(`${root}${path10.sep}`)) {
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
  await rm5(destination, { recursive: true, force: true });
  await mkdir4(destination, { recursive: true });
  const handle = await open3(archive, "r");
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
        await mkdir4(target, { recursive: true });
        extracted.push(target);
        continue;
      }
      await mkdir4(path10.dirname(target), { recursive: true });
      if (kind === S_IFLNK) {
        const linkTarget = (await readEntry(handle, dataOffset, compressedSize, method)).toString("utf8");
        const resolved = path10.resolve(path10.dirname(target), linkTarget);
        const root = path10.resolve(destination);
        if (resolved !== root && !resolved.startsWith(`${root}${path10.sep}`)) {
          throw new Error(`zip symlink escapes the destination: ${name} -> ${linkTarget}`);
        }
        await symlink2(linkTarget, target);
        extracted.push(target);
        continue;
      }
      if (compressedSize === 0) {
        await writeFile4(target, Buffer.alloc(0));
      } else if (method === 0 || method === 8) {
        const source = createReadStream2(archive, { start: dataOffset, end: dataOffset + compressedSize - 1 });
        const sink = createWriteStream3(target);
        if (method === 8) await pipeline3(source, createInflateRaw(), sink);
        else await pipeline3(source, sink);
      } else {
        throw new Error(`zip compression method ${String(method)} is not supported: ${name}`);
      }
      const written = (await stat4(target)).size;
      if (uncompressedSize !== 4294967295 && written !== uncompressedSize) {
        throw new Error(`zip entry has the wrong size: ${name} (${String(written)} != ${String(uncompressedSize)})`);
      }
      const permissions = mode & 511;
      if (permissions !== 0) await chmod4(target, permissions).catch(() => {
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
  if (configured !== "") return path11.resolve(configured);
  if (platform === "win32") {
    const localAppData = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA !== "" ? env.LOCALAPPDATA : path11.join(os5.homedir(), "AppData", "Local");
    return path11.join(localAppData, "dsh-mesh", "chrome");
  }
  const xdg = typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME !== "" ? env.XDG_CACHE_HOME : path11.join(os5.homedir(), ".cache");
  return path11.join(xdg, "dsh-mesh", "chrome");
}
function binaryName(platform) {
  return platform === "win32" ? `${ARTIFACT}.exe` : ARTIFACT;
}
async function findCachedChrome(cacheDir, platformKey, platform) {
  let entries;
  try {
    entries = await readdir4(cacheDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort((left, right) => right.localeCompare(left, void 0, { numeric: true }));
  for (const version of versions) {
    const binary = path11.join(cacheDir, version, platformKey, binaryName(platform));
    const info = await stat5(binary).catch(() => null);
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
  await mkdir5(path11.dirname(file), { recursive: true });
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
    await pipeline4(source, createWriteStream4(temporary));
    await rename3(temporary, file);
  } catch (error) {
    await rm6(temporary, { force: true }).catch(() => {
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
  await mkdir5(cacheDir, { recursive: true });
  const temporary = await mkdtemp2(path11.join(cacheDir, ".download-"));
  try {
    const archive = path11.join(temporary, `${ARTIFACT}.zip`);
    await downloadFile(resolved.url, archive, options);
    log(`extracting Chrome for Testing ${version}`);
    const extracted = path11.join(temporary, "extract");
    await extractZip(archive, extracted);
    const binary = path11.join(temporary, "extract", `${ARTIFACT}-${platformKey}`, binaryName(platform));
    const info = await stat5(binary).catch(() => null);
    if (info?.isFile() !== true) {
      throw new Error(`the ${platformKey} archive did not contain ${ARTIFACT}-${platformKey}/${binaryName(platform)}`);
    }
    await chmod5(binary, 493);
    const finalDir = path11.join(cacheDir, version, platformKey);
    await mkdir5(path11.dirname(finalDir), { recursive: true });
    await rm6(finalDir, { recursive: true, force: true });
    await rename3(path11.dirname(binary), finalDir);
    const installed = path11.join(finalDir, binaryName(platform));
    for (const entry of await readdir4(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === version) continue;
      await rm6(path11.join(cacheDir, entry.name), { recursive: true, force: true }).catch(() => {
      });
    }
    log(`Chrome for Testing ${version} ready: ${installed}`);
    return { binary: installed, version, platform: platformKey, cacheDir, cached: false };
  } finally {
    await rm6(temporary, { recursive: true, force: true }).catch(() => {
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
    for (const name of names) found.push(path12.join(dir, name));
  }
  return found;
}
function chromeCandidates(env = process.env, platform = process.platform) {
  const configured = [env.DSH_MESH_SMOKE_CHROME, env.DSH_GATE_CHROME].filter((value) => typeof value === "string" && value !== "");
  const edge = platform === "win32" ? [
    path12.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path12.join(env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path12.join(env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe")
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
    path12.join(env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path12.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path12.join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe")
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
  const [os11, arch] = String(target ?? "").split("-");
  return { os: os11 ?? "", arch: arch ?? "" };
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
  const candidates = process.platform === "win32" ? [path12.join(root, "runtime", "node", "node.exe"), path12.join(root, "runtime", "node", "bin", "node.exe")] : [path12.join(root, "runtime", "node", "bin", "node")];
  for (const candidate of candidates) {
    if (existsSync7(candidate)) return candidate;
  }
  return process.execPath;
}
function startProcess(options) {
  const detached = process.platform !== "win32";
  const child = spawn4(options.command, options.args, {
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
  const child = spawn4(node, args, { cwd: options.cwd, env: cleanEnv({}), stdio: ["ignore", "pipe", "pipe"] });
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
  }), options.timeoutMs ?? 12e4, `${path12.basename(args[0] ?? "node")} ${String(args[1] ?? "")}`);
  if (result.code !== 0) {
    throw new Error(`${path12.basename(args[0] ?? "node")} exited ${String(result.signal ?? result.code)}: ${output.trim().slice(-1200)}`);
  }
  return output;
}
async function prepareInstallRoot(packageRoot, workDir) {
  const root = path12.join(workDir, "install");
  await rm7(root, { recursive: true, force: true });
  await mkdir6(path12.join(root, "config"), { recursive: true });
  await mkdir6(path12.join(root, "data"), { recursive: true });
  await mkdir6(path12.join(root, "home", "profiles", "web"), { recursive: true });
  await mkdir6(path12.join(root, "workspace"), { recursive: true });
  for (const directory of ["app", "code", "gate", "plugins", "shared"]) {
    const source = path12.join(packageRoot, directory);
    if (!existsSync7(source)) throw new Error(`package is missing ${directory}/: ${packageRoot}`);
    await symlink3(source, path12.join(root, directory), process.platform === "win32" ? "junction" : "dir");
  }
  const runtime = path12.join(packageRoot, "runtime");
  if (!existsSync7(runtime)) throw new Error(`package is missing runtime/: ${packageRoot}`);
  await symlink3(runtime, path12.join(root, "runtime"), process.platform === "win32" ? "junction" : "dir");
  const entry = path12.join(packageRoot, "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync7(entry)) throw new Error(`package has no DSH app entry: ${entry}`);
  const patch = path12.join(packageRoot, "config", "browse-picker.patch.yml");
  if (existsSync7(patch)) await copyFile(patch, path12.join(root, "config", "browse-picker.patch.yml"));
  return root;
}
async function wireProfile(options) {
  const candidates = [
    path12.join(options.packageRoot, "code", "deploy", "wire-profile.mjs"),
    path12.join(options.packageRoot, "plugins", "dsh-mesh", "code", "deploy", "wire-profile.mjs")
  ];
  const script = candidates.find((candidate) => existsSync7(candidate));
  if (script === void 0) {
    throw new Error("package carries no code/deploy/wire-profile.mjs; cannot wire the DSH profile");
  }
  const envFile = path12.join(options.root, "config", "gate.env");
  await writeFile5(envFile, [
    `DSH_GATE_PORT=${String(options.port)}`,
    `DSH_GATE_PASSWORD=${options.password}`,
    `DSH_HOME=${options.home}`,
    `DSH_WORKDIR=${options.workdir}`,
    `DSH_GATE_DATA_DIR=${path12.join(options.root, "data")}`,
    ""
  ].join("\n"), { mode: 384 });
  const node = packageNode(options.packageRoot);
  const output = await runNode(node, [
    script,
    "--root",
    options.root,
    "--profile",
    path12.join(options.home, "profiles", "web"),
    "--env",
    envFile,
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
  const tokenFile = path12.join(root, "data", "dsh-web.json");
  await rm7(tokenFile, { force: true });
  const supervisor = startProcess({
    command: node,
    // `--preserve-symlinks-main` keeps ROOT at the scratch install even when
    // the scratch `code` directory is a symlink. Older supervisors (packages
    // built before DSH_PACKAGE_ROOT was honoured) then still write their token
    // into the scratch `data/` rather than into the package being tested.
    args: ["--preserve-symlinks-main", path12.join(root, "code", "dsh-service", "supervisor.mjs")],
    cwd: root,
    env: cleanEnv({
      DSH_HOME: options.home,
      DSH_WORKDIR: options.workdir,
      DSH_AGENTS_HOME: path12.join(options.home, "agents"),
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
      if (!existsSync7(tokenFile)) return null;
      try {
        const parsed = JSON.parse(await readFile8(tokenFile, "utf8"));
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
    args: [path12.join(root, "gate", "server.mjs")],
    cwd: root,
    env: cleanEnv({
      DSH_HOME: options.home,
      DSH_WORKDIR: options.workdir,
      DSH_GATE_DATA_DIR: path12.join(root, "data"),
      DSH_GATE_PORT: String(options.port),
      // Never expose the throwaway instance beyond loopback: its password is
      // fixed for the test and the build host may be on a public network.
      DSH_GATE_BIND: "127.0.0.1",
      DSH_GATE_PASSWORD: options.password,
      DSH_GATE_NO_SPAWN: "1",
      DSH_WEB_TOKEN_FILE: tokenFile,
      DSH_GATE_MEMBER_PORT: String(options.port),
      DSH_PACKAGE_ROOT: root,
      DSH_APP_DIR: path12.join(root, "app"),
      DSH_GATE_PATCH: path12.join(root, "config", "browse-picker.patch.yml")
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
    const shellShot = path12.join(options.screenshotDir, `dsh-${options.target}.png`);
    await mkdir6(options.screenshotDir, { recursive: true });
    await writeFile5(shellShot, await withTimeout(session.screenshot(), 3e4, "screenshot the shell"));
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
      const panelShot = path12.join(options.screenshotDir, `mesh-${options.target}.png`);
      await writeFile5(panelShot, await withTimeout(session.screenshot(), 3e4, "screenshot the Mesh panel"));
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
        await mkdir6(options.screenshotDir, { recursive: true });
        const failure = path12.join(options.screenshotDir, `failure-${options.target}.png`);
        await writeFile5(failure, await withTimeout(session.screenshot(), 15e3, "screenshot the failure"));
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
  if (options.packageRoot === void 0 || !existsSync7(options.packageRoot)) {
    return { ...skipped("package directory does not exist", base), ok: false, status: "failed", error: `package directory does not exist: ${String(options.packageRoot)}` };
  }
  if (!isNativeTarget(target)) {
    return skipped(`${target} cannot run on ${targetOs()}-${process.arch}`, base);
  }
  const ownsWorkDir = options.workDir === void 0;
  const workDir = options.workDir ?? await mkdtemp3(path12.join(os6.tmpdir(), "dsh-mesh-smoke-"));
  await mkdir6(workDir, { recursive: true });
  const logFile = path12.join(workDir, "smoke.log");
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
    if (ownsWorkDir && options.keep !== true) await rm7(workDir, { recursive: true, force: true }).catch(() => {
    });
    return options.required === true ? { ...skipped(reason, base), ok: false, status: "failed", error: reason } : skipped(reason, base);
  }
  if (resolved.source === "downloaded") {
    try {
      await probeDownloadedChrome(resolved.chrome, log);
    } catch (error) {
      const reason = `downloaded Chrome for Testing ${resolved.version ?? ""} could not start: ${browserStartReason(error)}`;
      log(reason);
      if (ownsWorkDir && options.keep !== true) await rm7(workDir, { recursive: true, force: true }).catch(() => {
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
    const home = path12.join(root, "home");
    const worktree = path12.join(root, "workspace");
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
    if (root !== void 0 && options.keep !== true) await rm7(root, { recursive: true, force: true }).catch(() => {
    });
    if (ownsWorkDir && options.keep !== true) await rm7(workDir, { recursive: true, force: true }).catch(() => {
    });
  }
}

// code/build/stamp.mjs
import { mkdir as mkdir7, readFile as readFile9, readdir as readdir5, rename as rename4, writeFile as writeFile6 } from "node:fs/promises";
import os7 from "node:os";
import path13 from "node:path";
function defaultStampFile() {
  return path13.join(os7.homedir(), ".dsh", "mesh", "build-stamp.json");
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
  const packagesDir = options.packagesDir ?? path13.join(os7.homedir(), ".dsh", "packages");
  let state = {};
  try {
    state = JSON.parse(await readFile9(stateFile, "utf8"));
  } catch {
    state = {};
  }
  let next = state?.date === date && Number.isSafeInteger(state.next) && state.next > 0 ? state.next : 1;
  const names = await readdir5(packagesDir).catch(() => []);
  next = Math.max(next, highestFromNames(names, date) + 1);
  const stamp = `${date}${letterFor(next)}`;
  await mkdir7(path13.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${String(process.pid)}.tmp`;
  await writeFile6(temporary, `${JSON.stringify({
    format: 1,
    date,
    next: next + 1,
    last: stamp,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  }, null, 2)}
`, "utf8");
  await rename4(temporary, stateFile);
  return stamp;
}

// code/build/progress.mjs
var BUILD_DONE = 65;
var PACKAGE_END = 95;
var STAGE_FACTOR = { start: 0, install: 0.15, smoke: 0.55, archive: 0.85, end: 1 };
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
function phaseFromLine(line, targets = ["linux-x64"], context = {}) {
  const text = String(line);
  const list = Array.isArray(targets) && targets.length > 0 ? targets : ["linux-x64"];
  const known = typeof context?.currentTarget === "string" && context.currentTarget !== "" ? context.currentTarget : null;
  if (text.includes("job created")) return { phase: "prepare", percent: 2 };
  if (text.includes("extracting ")) return { phase: "prepare", percent: 6 };
  if (text.includes("needs-fix")) return { phase: "apply", percent: 14, status: "needs-fix" };
  if (/^(?:applied|skipped) /u.test(text)) return { phase: "apply", percent: 11 };
  if (text.includes("$ pnpm install") || text.includes("$ pnpm i")) return { phase: "build", percent: 18 };
  if (text.startsWith("prefetch app ")) return { phase: "build", percent: 20 };
  if (text.includes("web build cache hit")) return { phase: "build", percent: 62 };
  if (text.startsWith("Progress: resolved")) return { phase: "build", percent: 30 };
  if (text.includes("$ pnpm run build:web") || text.includes("$ pnpm build")) return { phase: "build", percent: 50 };
  if (/^\$ pnpm (?:exec|run) /u.test(text)) return { phase: "build", percent: 44 };
  const packaging = /^packaging (\S+)$/u.exec(text.trim());
  if (packaging !== null) {
    return { phase: "package", percent: targetPercent(list, packaging[1], "start"), currentTarget: packaging[1] };
  }
  if (text.includes("$ npm install @deepseek-ai/dsh")) {
    const target = known ?? list[0];
    return { phase: "package", percent: targetPercent(list, target, "install"), currentTarget: target };
  }
  const stagedStep = /^(?:node runtime|archiving) (\S+)$/u.exec(text.trim());
  if (stagedStep !== null) {
    return { phase: "package", percent: targetPercent(list, stagedStep[1], "archive"), currentTarget: stagedStep[1] };
  }
  if (text.includes("frontend installed") || text.includes("patching ")) {
    const target = known ?? list[0];
    return { phase: "package", percent: targetPercent(list, target, "install"), currentTarget: target };
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
import { createHash as createHash3 } from "node:crypto";
import { createReadStream as createReadStream4, createWriteStream as createWriteStream6 } from "node:fs";
import { chmod as chmod6, mkdtemp as mkdtemp4, mkdir as mkdir8, readFile as readFile10, rm as rm9, stat as stat7, writeFile as writeFile7 } from "node:fs/promises";
import { homedir, tmpdir as tmpdir2 } from "node:os";
import path14 from "node:path";
import { finished } from "node:stream/promises";

// code/shared/http-client.mjs
import { createReadStream as createReadStream3, createWriteStream as createWriteStream5 } from "node:fs";
import { rm as rm8, rename as rename5, stat as stat6 } from "node:fs/promises";
import http2 from "node:http";
import https2 from "node:https";
import { PassThrough, Readable as Readable4, Transform as Transform2 } from "node:stream";
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
  const info = await stat6(options.file);
  const retries = Number.isSafeInteger(options.retries) ? Math.max(0, options.retries) : 2;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const delay2 = 1e3 * 2 ** (attempt - 1);
      log(`upload retry ${String(attempt)}/${String(retries)} in ${String(delay2)}ms: ${lastError === null ? "" : lastError.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay2));
    }
    let sent = 0;
    let lastReport = 0;
    let lastSent = 0;
    const stream = new Transform2({
      transform(chunk, _encoding, callback) {
        sent += chunk.length;
        const now = Date.now();
        if (now - lastReport >= 250) {
          const speed = (sent - lastSent) / Math.max(1e-3, (now - lastReport) / 1e3);
          lastReport = now;
          lastSent = sent;
          options.onProgress?.({
            bytes: sent,
            totalBytes: info.size,
            percent: info.size > 0 ? Math.min(100, Math.round(sent / info.size * 100)) : 0,
            speed
          });
        }
        callback(null, chunk);
      }
    });
    const file = createReadStream3(options.file);
    file.once("error", (error) => stream.destroy(error));
    file.pipe(stream);
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
      if (response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500) {
        lastError = new Error(`upload ${url} answered HTTP ${String(response.statusCode)}: ${text.trim().slice(0, 300)}`);
        file.destroy();
        stream.destroy();
        if (attempt < retries) continue;
        throw lastError;
      }
      if (isSuccess(response.statusCode)) {
        options.onProgress?.({ bytes: info.size, totalBytes: info.size, percent: 100, speed: 0 });
      }
      return { status: response.statusCode, headers: response.headers, text, json: json2, bytes: info.size };
    } catch (error) {
      file.destroy();
      stream.destroy();
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= retries) throw lastError;
    }
  }
  throw lastError ?? new Error(`upload ${url} failed`);
}
async function multipartFileBody(options) {
  const boundary = `----dsh-mesh-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const info = await stat6(options.file);
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
  const file = createReadStream3(options.file);
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
var DEFAULT_RELEASE_REPO = "dsh-web-release";
var DEFAULT_GITEE_BRANCH = "master";
var DEFAULT_PART_BYTES = 85 * 1024 * 1024;
var MAX_PART_BYTES = 95 * 1024 * 1024;
var LATEST_MANIFEST_NAME = "latest.json";
var GITEE_REPO_QUOTA_BYTES = 950 * 1024 * 1024;
function defaultReleaseConfigFile() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME.trim() : path14.join(homedir(), ".dsh");
  return path14.join(home, "mesh", "release.json");
}
function normalizeRepo(value) {
  if (value === null || typeof value !== "object") return { owner: "", repo: DEFAULT_RELEASE_REPO };
  const owner = String(value.owner ?? "").trim();
  const repo = String(value.repo ?? "").trim();
  const valid = (part) => /^[A-Za-z0-9_.-]+$/u.test(part);
  return { owner: valid(owner) ? owner : "", repo: repo === "" ? DEFAULT_RELEASE_REPO : valid(repo) ? repo : "" };
}
async function detectReleaseOwner(provider, options) {
  const token = String(options.token ?? "").trim();
  if (token === "") throw new Error(`${provider} token \u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u8BC6\u522B\u8D26\u53F7`);
  const fallback = provider === "github" ? "https://api.github.com" : "https://gitee.com/api/v5";
  const apiBase = String(options.apiBase ?? fallback).replace(/\/$/u, "");
  const url = new URL(`${apiBase}/user`);
  const headers = {};
  if (provider === "gitee") {
    url.searchParams.set("access_token", token);
  } else {
    headers.authorization = `Bearer ${token}`;
    headers.accept = "application/vnd.github+json";
    headers["x-github-api-version"] = "2022-11-28";
  }
  const response = await requestJson(url.href, {
    headers,
    proxy: provider === "gitee" ? null : options.proxy ?? null,
    timeoutMs: 3e4,
    idleTimeoutMs: 6e4
  });
  if (!isSuccess(response.status) || response.json === null || typeof response.json !== "object") {
    const hint = response.status === 401 || response.status === 403 ? `${provider} token \u65E0\u6548\u6216\u7F3A\u5C11\u8BFB\u53D6\u8D26\u53F7\u7684\u6743\u9650` : `${provider} \u65E0\u6CD5\u7528 token \u8BC6\u522B\u8D26\u53F7`;
    throw new Error(`${hint}\uFF1AHTTP ${String(response.status)} ${String(response.text ?? "").slice(0, 200)}`);
  }
  const login = String(response.json.login ?? response.json.username ?? "").trim();
  if (login === "") throw new Error(`${provider} /user \u6CA1\u6709\u8FD4\u56DE\u8D26\u53F7\u540D`);
  return login;
}
async function loadReleaseConfig(options = {}) {
  const file = options.file ?? defaultReleaseConfigFile();
  const env = options.env ?? process.env;
  let parsed = {};
  let fileError = null;
  try {
    parsed = JSON.parse(await readFile10(file, "utf8"));
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
    // The owner can stay empty: a token-only setup resolves it from the token
    // (`detectReleaseOwner`) at save time and again right before publishing.
    github: {
      ...github,
      token: githubToken,
      enabled: enabled && github.repo !== "" && githubToken !== ""
    },
    gitee: {
      ...gitee,
      token: giteeToken,
      enabled: enabled && gitee.repo !== "" && giteeToken !== "",
      // Gitee needs a real commit-ish to point the `latest` tag at.
      branch: typeof parsed.gitee?.branch === "string" && parsed.gitee.branch.trim() !== "" ? parsed.gitee.branch.trim() : DEFAULT_GITEE_BRANCH
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
      branch: config.gitee?.branch ?? DEFAULT_GITEE_BRANCH,
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
  const branch = String(input.gitee?.branch ?? existing.gitee?.branch ?? DEFAULT_GITEE_BRANCH).trim();
  if (!/^[A-Za-z0-9._/-]{1,120}$/u.test(branch)) throw new Error(`Gitee branch is invalid: ${branch}`);
  const stored = {
    enabled: input.enabled === void 0 ? existing.enabled !== false : input.enabled === true,
    tag,
    partBytes: Number.isFinite(requestedPart) ? Math.min(Math.round(requestedPart), MAX_PART_BYTES) : DEFAULT_PART_BYTES,
    github: { owner: github.owner, repo: github.repo, token: githubToken },
    gitee: { owner: gitee.owner, repo: gitee.repo, token: giteeToken, branch }
  };
  await mkdir8(path14.dirname(file), { recursive: true });
  await writeFile7(file, `${JSON.stringify(stored, null, 2)}
`, { encoding: "utf8", mode: 384 });
  await chmod6(file, 384).catch(() => {
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
  const hash = createHash3("sha256");
  await finished(createReadStream4(file).on("data", (chunk) => hash.update(chunk)));
  return hash.digest("hex");
}
async function copyRange(source, destination, start, end) {
  const input = createReadStream4(source, { start, end });
  const output = createWriteStream6(destination);
  input.once("error", (error) => output.destroy(error));
  input.pipe(output);
  await finished(output);
}
async function splitArchive(file, options = {}) {
  const log = options.log ?? (() => {
  });
  const partBytes = Number.isSafeInteger(options.partBytes) ? Math.min(Math.max(options.partBytes, 1024 * 1024), MAX_PART_BYTES) : DEFAULT_PART_BYTES;
  const info = await stat7(file);
  if (!info.isFile()) throw new Error(`not a file: ${file}`);
  const dir = options.dir ?? await mkdtemp4(path14.join(tmpdir2(), "dsh-mesh-release-"));
  await mkdir8(dir, { recursive: true });
  const name = path14.basename(file);
  const count = Math.max(1, Math.ceil(info.size / partBytes));
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * partBytes;
    const end = Math.min(info.size, start + partBytes) - 1;
    const partName = `${name}.part${String(index + 1).padStart(3, "0")}`;
    const partPath = path14.join(dir, partName);
    await rm9(partPath, { force: true });
    await copyRange(file, partPath, start, end);
    const partInfo = await stat7(partPath);
    parts.push({ name: partName, path: partPath, bytes: partInfo.size });
    log(`split ${name}: ${partName} (${formatBytes(partInfo.size)})`);
  }
  return { file, dir, partBytes, parts };
}
async function removeSplit(dir) {
  await rm9(dir, { recursive: true, force: true }).catch(() => {
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
async function withRetry(run3, options = {}) {
  const retries = Number.isSafeInteger(options.retries) ? Math.max(0, options.retries) : 2;
  const log = options.log ?? (() => {
  });
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const delay2 = 1e3 * 2 ** (attempt - 1);
      log(`${options.label ?? "request"} retry ${String(attempt)}/${String(retries)} in ${String(delay2)}ms (${lastError === null ? "" : lastError.message})`);
      await new Promise((resolve) => setTimeout(resolve, delay2));
    }
    try {
      return await run3();
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
    const url = /^https?:\/\//u.test(endpoint) ? endpoint : `${this.apiRoot}${endpoint}`;
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
   * Create the repository when the token can see nothing at that address.
   *
   * The panel only takes a token, so the first publish has to be able to make
   * the repository itself; `ensureRelease` then makes the tag. A repository
   * that already exists is left alone.
   * @returns {Promise<{created: boolean}>} whether a repository was created.
   */
  async ensureRepo() {
    const found = await this.#api("");
    if (found.status === 200) return { created: false };
    if (found.status !== 404) {
      throw new Error(`GitHub repository lookup failed for ${this.owner}/${this.repo}: HTTP ${String(found.status)} ${found.text.slice(0, 300)}`);
    }
    const me = await this.#api(`${this.apiBase}/user`);
    const login = me.status === 200 ? String(me.json?.login ?? "").trim() : "";
    if (login === "") {
      throw new Error(`GitHub \u4ED3\u5E93 ${this.owner}/${this.repo} \u4E0D\u5B58\u5728\uFF0C\u4E14 token \u65E0\u6CD5\u8BC6\u522B\u8D26\u53F7\uFF0C\u65E0\u6CD5\u81EA\u52A8\u521B\u5EFA`);
    }
    const body = {
      name: this.repo,
      description: "dsh-mesh deployment packages (created by dsh-mesh)",
      private: false,
      auto_init: true
    };
    const endpoints = this.owner.toLowerCase() === login.toLowerCase() ? [`${this.apiBase}/user/repos`] : [`${this.apiBase}/orgs/${this.owner}/repos`];
    let last = null;
    for (const endpoint of endpoints) {
      last = await this.#api(endpoint, { json: body });
      if (isSuccess(last.status)) {
        this.log(`github repository ${this.owner}/${this.repo} created`);
        return { created: true };
      }
    }
    throw new Error(`GitHub \u4ED3\u5E93 ${this.owner}/${this.repo} \u81EA\u52A8\u521B\u5EFA\u5931\u8D25\uFF1AHTTP ${String(last?.status)} ${String(last?.text ?? "").slice(0, 300)}`);
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
    const name = path14.basename(file);
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
    this.assetCache = [...(this.assetCache ?? []).filter((asset) => asset.name !== name), { name, size: (await stat7(file)).size }];
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
    this.branch = options.branch ?? DEFAULT_GITEE_BRANCH;
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
   * One API request against an absolute URL. The token travels in the query for
   * GET/DELETE and in the JSON body for writes; it is never part of a log line.
   * @param {string} target absolute URL.
   * @param {{method?: string, json?: unknown, query?: Record<string,string>, label?: string}} [options] request.
   * @returns {Promise<{status:number, json:any, text:string}>} response.
   */
  async #raw(target, options = {}) {
    const url = new URL(target);
    url.searchParams.set("access_token", this.token);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
    const method = options.method ?? (options.json === void 0 ? "GET" : "POST");
    const label = options.label ?? url.pathname;
    const response = await withRetry(async () => {
      const result = await requestJson(url.href, {
        method,
        json: options.json === void 0 ? void 0 : { ...options.json, access_token: this.token },
        proxy: this.proxy,
        timeoutMs: 6e4,
        idleTimeoutMs: 18e4
      });
      if (result.status === 429 || result.status >= 500) {
        throw retryable(new Error(`Gitee API ${method} ${label} returned HTTP ${String(result.status)}: ${result.text.slice(0, 300)}`));
      }
      return result;
    }, { log: this.log, label: `gitee ${method} ${label}` });
    return response;
  }
  /**
   * One API request below the repository root.
   * @param {string} endpoint path below the repo root.
   * @param {{method?: string, json?: unknown, query?: Record<string,string>}} [options] request.
   * @returns {Promise<{status:number, json:any, text:string}>} response.
   */
  async #api(endpoint, options = {}) {
    return await this.#raw(`${this.apiRoot}${endpoint}`, options);
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
    const foundRelease = found.status === 200 && found.json !== null && typeof found.json === "object" && Object.keys(found.json).length > 0 ? found.json : null;
    if (foundRelease !== null) {
      return { id: foundRelease.id, tag_name: foundRelease.tag_name, html_url: foundRelease.html_url };
    }
    const missing = found.status === 404 || found.status === 200 && foundRelease === null;
    if (!missing) {
      throw new Error(`Gitee release lookup failed: HTTP ${String(found.status)} ${found.text.slice(0, 300)}`);
    }
    const create = async (branch) => await this.#api("/releases", {
      json: {
        tag_name: tag,
        name: options.name ?? `latest packages (${tag})`,
        body: options.body ?? "The newest dsh-mesh deployment packages. Older assets are replaced on every build.",
        target_commitish: branch,
        prerelease: false
      }
    });
    let created = await create(this.branch);
    if (!isSuccess(created.status) && this.defaultBranch !== null && this.defaultBranch !== this.branch) {
      const retried = await create(this.defaultBranch);
      if (isSuccess(retried.status)) {
        this.log(`gitee branch ${this.branch} is missing; using ${this.defaultBranch}`);
        this.branch = this.defaultBranch;
        created = retried;
      }
    }
    if (!isSuccess(created.status) || created.json === null) {
      const detail = created.json?.message ?? created.text.slice(0, 300);
      const hint = /not found|404/iu.test(detail) ? `\uFF08Gitee \u4ED3\u5E93\u6216\u5206\u652F\u4E0D\u5B58\u5728\uFF1A\u8BF7\u786E\u8BA4 branch \u4E3A ${this.defaultBranch ?? this.branch}\uFF0C\u5E76\u7ED9 token projects \u6743\u9650\uFF09` : "";
      throw new Error(`Gitee release creation failed: HTTP ${String(created.status)} ${detail}${hint}`);
    }
    return { id: created.json.id, tag_name: created.json.tag_name, html_url: created.json.html_url };
  }
  /**
   * Create the repository when the token can see nothing at that address.
   *
   * A repository is created in the token's own namespace (`/user/repos`) or,
   * when `owner` names somebody else, as an organisation repository. It is
   * initialised (`auto_init`) so the `latest` tag has a commit to point at.
   * @returns {Promise<{created: boolean}>} whether a repository was created.
   */
  async ensureRepo() {
    const found = await this.#api("");
    const repository = found.status === 200 && found.json !== null && typeof found.json === "object" && Object.keys(found.json).length > 0 ? found.json : null;
    if (repository !== null) {
      this.defaultBranch = typeof repository.default_branch === "string" && repository.default_branch !== "" ? repository.default_branch : null;
      if (repository.private === true) {
        this.log(`gitee repository ${this.owner}/${this.repo} is private; member downloads will get 403 \u2014 make it public in the repository settings`);
      }
      return { created: false };
    }
    if (found.status !== 404 && !(found.status === 200 && repository === null)) {
      throw new Error(`Gitee repository lookup failed for ${this.owner}/${this.repo}: HTTP ${String(found.status)} ${found.text.slice(0, 300)}`);
    }
    const me = await this.#raw(`${this.apiBase}/user`, { label: "/user" });
    const login = me.status === 200 ? String(me.json?.login ?? me.json?.name ?? "").trim() : "";
    if (login === "") {
      throw new Error(`Gitee \u4ED3\u5E93 ${this.owner}/${this.repo} \u4E0D\u5B58\u5728\uFF0C\u4E14 token \u65E0\u6CD5\u8BC6\u522B\u8D26\u53F7\uFF0C\u65E0\u6CD5\u81EA\u52A8\u521B\u5EFA`);
    }
    const underUser = login.toLowerCase() === this.owner.toLowerCase();
    const endpoints = underUser ? [`${this.apiBase}/user/repos`] : [`${this.apiBase}/orgs/${this.owner}/repos`];
    const body = {
      name: this.repo,
      description: "dsh-mesh deployment packages (created by dsh-mesh)",
      private: false,
      auto_init: true
    };
    let created = null;
    for (const endpoint of endpoints) {
      created = await this.#raw(endpoint, { json: body, label: `/repos create ${this.owner}/${this.repo}` });
      if (isSuccess(created.status)) break;
    }
    if (created === null || !isSuccess(created.status)) {
      const detail = created?.json?.message ?? String(created?.text ?? "").slice(0, 300);
      const hint = `\uFF08token \u5C5E\u4E8E ${login}\uFF1B\u81EA\u52A8\u5EFA\u4ED3\u5E93\u9700\u8981 projects \u6743\u9650\uFF0C\u4E14 ${this.owner} \u5FC5\u987B\u662F token \u81EA\u5DF1\u6216\u5B83\u6709\u5199\u6743\u9650\u7684\u7EC4\u7EC7\uFF09`;
      throw new Error(`Gitee \u4ED3\u5E93 ${this.owner}/${this.repo} \u4E0D\u5B58\u5728\u4E14\u81EA\u52A8\u521B\u5EFA\u5931\u8D25\uFF1AHTTP ${String(created?.status)} ${detail}${hint}`);
    }
    this.defaultBranch = typeof created.json?.default_branch === "string" && created.json.default_branch !== "" ? created.json.default_branch : null;
    const patched = await this.#raw(`${this.apiBase}/repos/${this.owner}/${this.repo}`, {
      method: "PATCH",
      json: { name: this.repo, private: false },
      label: `/repos patch ${this.owner}/${this.repo}`
    });
    if (!isSuccess(patched.status)) {
      this.log(`gitee repository ${this.owner}/${this.repo} was created but switching it to public failed (HTTP ${String(patched.status)}); member downloads will get 403 until it is public`);
      return { created: true };
    }
    const visible = await this.#api("");
    if (visible.status === 200 && visible.json !== null && visible.json.private === false) {
      this.log(`gitee repository ${this.owner}/${this.repo} created (public)`);
    } else {
      this.log(`gitee repository ${this.owner}/${this.repo} created but still private; member downloads will get 403 until it is public`);
    }
    return { created: true };
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
    const name = path14.basename(file);
    const known = this.assetCache ?? await this.listAssets(releaseId);
    const existing = known.find((asset) => asset.name === name);
    if (existing !== void 0) await this.deleteAsset(releaseId, existing.id);
    const url = new URL(`${this.apiRoot}/releases/${String(releaseId)}/attach_files`);
    url.searchParams.set("access_token", this.token);
    const form = await multipartFileBody({ name, file });
    let lastError = null;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      if (attempt > 0) {
        const delay2 = 1e3 * 2 ** (attempt - 1);
        this.log(`gitee upload retry ${String(attempt)}/2 in ${String(delay2)}ms (${lastError === null ? "" : lastError.message})`);
        await new Promise((resolve) => setTimeout(resolve, delay2));
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
    const name = path14.basename(String(artifact.archive ?? ""));
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
      const file = path14.resolve(artifact.archive);
      const info = await stat7(file);
      const digest = artifact.sha256 ?? await sha256File2(file);
      prepared.push({ ...artifact, archive: file, bytes: info.size, sha256: digest });
      log(`release asset ${path14.basename(file)} (${formatBytes(info.size)}, sha256 ${digest.slice(0, 12)}\u2026)`);
    }
    if (config.github.enabled && config.github.owner === "") {
      config.github.owner = await detectReleaseOwner("github", {
        token: config.github.token,
        proxy: proxy2,
        apiBase: config.github.apiBase
      });
      log(`github owner detected: ${config.github.owner}`);
    }
    if (config.gitee.enabled && config.gitee.owner === "") {
      config.gitee.owner = await detectReleaseOwner("gitee", {
        token: config.gitee.token,
        apiBase: config.gitee.apiBase
      });
      log(`gitee owner detected: ${config.gitee.owner}`);
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
    const manifestFile = path14.join(splits[0] ?? await mkdtemp4(path14.join(tmpdir2(), "dsh-mesh-release-")), LATEST_MANIFEST_NAME);
    if (splits.length === 0) splits.push(path14.dirname(manifestFile));
    await writeFile7(manifestFile, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
    result.manifest = { ...manifest, assets: manifest.assets };
    if (config.github.enabled) {
      try {
        const github = new GitHubRelease(config.github, { proxy: proxy2, log, apiBase: config.github.apiBase, uploadBase: config.github.uploadBase, webBase: config.github.webBase });
        const repository = await github.ensureRepo();
        result.github.created = repository.created === true;
        const release = await github.ensureRelease(config.tag, { name: `dsh-mesh ${manifest.version ?? ""} ${manifest.buildStamp ?? ""}`.trim() });
        result.github.releaseUrl = release.html_url ?? github.htmlUrl;
        for (const artifact of prepared) {
          const name = path14.basename(artifact.archive);
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
        result.github.assets.push({ name: LATEST_MANIFEST_NAME, bytes: (await stat7(manifestFile)).size });
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
        const repository = await gitee.ensureRepo();
        result.gitee.created = repository.created === true;
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
        await writeFile7(manifestFile, `${JSON.stringify(finalManifest, null, 2)}
`, "utf8");
        log(`gitee upload ${LATEST_MANIFEST_NAME}`);
        await gitee.uploadAsset(release.id, manifestFile);
        result.gitee.assets.push({ name: LATEST_MANIFEST_NAME, bytes: (await stat7(manifestFile)).size });
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
async function fetchLatestManifest(options) {
  const log = options.log ?? (() => {
  });
  const errors = [];
  for (const url of options.urls ?? []) {
    try {
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        host = "";
      }
      const proxy2 = /(?:^|\.)github\.com$|githubusercontent\.com$/iu.test(host) ? options.proxy ?? null : null;
      const response = await requestJson(url, {
        proxy: proxy2,
        timeoutMs: options.timeoutMs ?? 3e4,
        idleTimeoutMs: options.timeoutMs ?? 3e4,
        headers: { accept: "application/json" }
      });
      if (!isSuccess(response.status) || response.json === null || typeof response.json !== "object") {
        errors.push(`${url}: HTTP ${String(response.status)}`);
        continue;
      }
      log(`release manifest ${url}`);
      return { manifest: response.json, url };
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`no release manifest is reachable
${errors.join("\n")}`);
}

// code/build/job.mjs
function defaultJobRoot() {
  return path15.join(os8.homedir(), ".dsh", "mesh", "build");
}
function defaultCacheDir2() {
  return path15.join(os8.homedir(), ".dsh", "mesh", "cache");
}
async function createJob(options = {}) {
  const root = options.root ?? defaultJobRoot();
  const id = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`;
  const dir = path15.join(root, id);
  await mkdir9(dir, { recursive: true });
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
  return JSON.parse(await readFile11(path15.join(dir, "state.json"), "utf8"));
}
async function writeState(dir, state) {
  const file = path15.join(dir, "state.json");
  const temporary = `${file}.tmp`;
  await writeFile8(temporary, JSON.stringify({ ...state, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), "utf8");
  await rename6(temporary, file);
}
async function appendLog(dir, line) {
  await appendFile2(path15.join(dir, "build.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, "utf8");
}
async function readLogTail(dir, lines = 80) {
  try {
    const text = await readFile11(path15.join(dir, "build.log"), "utf8");
    const trimmed = text.trimEnd();
    if (trimmed === "") return [];
    return trimmed.split(/\r?\n/u).slice(-lines);
  } catch {
    return [];
  }
}
var stateQueues = /* @__PURE__ */ new Map();
function updateState(dir, patch) {
  const previous = stateQueues.get(dir) ?? Promise.resolve();
  const run3 = previous.catch(() => {
  }).then(async () => {
    const state = { ...await readState(dir), ...patch };
    await writeState(dir, state);
    return state;
  });
  stateQueues.set(dir, run3);
  return run3;
}
function unverifiedBuildReason(artifacts, options = {}) {
  if (options.full === false || options.smoke === false) return null;
  if (artifacts.some((artifact) => artifact.smoke?.status === "passed")) return null;
  const detail = artifacts.map((artifact) => `${artifact.target}: ${artifact.smoke?.status ?? "not run"}${artifact.smoke?.reason === void 0 ? "" : ` (${artifact.smoke.reason})`}`).join("; ");
  return `no target was booted in a browser (${detail}). Install Chrome/Chromium/Edge or set DSH_MESH_SMOKE_CHROME, build on a host that can run at least one target, or pass --no-smoke to accept an unverified package explicitly.`;
}
async function runJob(dir, options) {
  const repositoryRoot = options.repositoryRoot;
  const recipesPath = options.recipesPath ?? path15.join(repositoryRoot, "build", "recipes.json");
  const overlayRoot = options.overlayRoot ?? path15.join(repositoryRoot, "build", "overlays");
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
    const prepared = options.reuseWorktree === true && existsSync8(path15.join(dir, "src")) ? { dir: path15.join(dir, "src"), source: state.source, ref: state.ref, local: false, archiveSha256: state.archiveSha256 ?? null } : await prepareSource({
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
        dir: path15.join(dir, "work-order"),
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
    const full = options.full !== false;
    const targets = state.targets;
    const cacheDir = options.cacheDir ?? defaultCacheDir2();
    const env = options.env ?? process.env;
    const cacheEnabled = options.cache !== false && !cachesDisabled(env);
    const version = options.version ?? await readSourceVersion(prepared.dir);
    const pluginVersion = await readPluginVersion(repositoryRoot);
    const fingerprint = await pluginFingerprint(repositoryRoot);
    const webKey = cacheEnabled ? await webBuildCacheKey({
      archiveSha256: prepared.archiveSha256 ?? state.archiveSha256 ?? null,
      source: state.source,
      recipesFile: recipesPath,
      overlayRoot,
      prepare: options.prepare ?? (Array.isArray(recipes.prepare) ? recipes.prepare : null),
      install: options.install,
      build: options.build,
      prebuild: options.prebuild !== false
    }) : null;
    let prefetch = Promise.resolve();
    if (cacheEnabled && full) {
      prefetch = (async () => {
        for (const target of targets) {
          log(`prefetch app ${target}`);
          try {
            await ensureAppCache({
              cacheDir,
              version,
              target,
              repositoryRoot,
              env: outbound.env,
              refresh: options.refreshAppCache === true,
              log
            });
          } catch (error) {
            log(`prefetch app ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      })().catch((error) => {
        log(`app prefetch stopped: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    let built;
    try {
      built = await runWebBuild({
        dir: prepared.dir,
        log,
        install: options.install,
        build: options.build,
        prepare: options.prepare ?? (Array.isArray(recipes.prepare) ? recipes.prepare : null),
        env: outbound.env,
        prebuild: options.prebuild,
        cacheDir: cacheEnabled ? cacheDir : null,
        cacheKey: webKey,
        cacheMeta: {
          source: state.source,
          ref: state.ref,
          archiveSha256: prepared.archiveSha256 ?? null,
          tree: recipes.tree ?? null
        },
        refreshCache: options.refreshWebCache === true,
        // The install and the web build are the two long silent steps; the
        // panel would otherwise sit at 12% until packaging starts.
        onProgress: async (update) => {
          state = await updateState(dir, { phase: update.phase, percent: update.percent });
        }
      });
    } finally {
      await prefetch;
    }
    if (!built.ok) {
      state = await updateState(dir, { status: "build-failed", phase: "build", error: built.error ?? "web build failed" });
      log(`build failed: ${built.error ?? "unknown error"}`);
      return state;
    }
    state = await updateState(dir, {
      phase: "package",
      percent: 65,
      version,
      pluginVersion,
      pluginFingerprint: fingerprint,
      dist: built.dist,
      webBuild: { cached: built.cached === true, key: webKey === null ? null : webKey.slice(0, 12) }
    });
    const appCacheDir2 = cacheEnabled ? cacheDir : null;
    const jobSource = state.source;
    const jobRef = state.ref;
    const sourceEtag = state.archiveEtag ?? null;
    const artifacts = [];
    let failure = null;
    let reported = 65;
    const concurrency = packagingConcurrency({
      targets: targets.length,
      requested: options.concurrency,
      env
    });
    if (concurrency > 1) log(`packaging ${String(targets.length)} targets with up to ${String(concurrency)} at a time`);
    const advance = async (target, stage, extra = {}) => {
      reported = Math.max(reported, targetPercent(targets, target, stage));
      state = await updateState(dir, {
        phase: stage === "smoke" ? "smoke" : "package",
        percent: reported,
        currentTarget: target,
        ...extra
      });
    };
    const packageTarget = async (target) => {
      await advance(target, "start");
      log(`packaging ${target}`);
      const shared = {
        dist: built.dist,
        target,
        outputDir: path15.join(dir, "dist"),
        version,
        buildStamp,
        repositoryRoot,
        source: jobSource,
        ref: jobRef,
        tree: recipes.tree ?? null,
        sourceEtag,
        pluginVersion,
        pluginFingerprint: fingerprint,
        fetchImpl: outbound.fetchImpl,
        env: outbound.env,
        cacheDir,
        log
      };
      const assembled = full ? await assembleRuntimePackage({
        ...shared,
        dshVersion: version,
        nodeVersion: options.nodeVersion ?? process.versions.node,
        appCacheDir: appCacheDir2,
        refreshAppCache: options.refreshAppCache === true
      }) : await assembleWebPackage(shared);
      const archive = await archivePackage(assembled.packageDir, target, {
        log,
        env: outbound.env,
        threads: options.archiveThreads,
        repositoryRoot,
        format: options.archiveFormat
      });
      const info = await stat8(archive);
      let smoke = null;
      if (options.smoke === false) {
        smoke = { ok: true, status: "skipped", reason: "smoke test disabled for this build", checks: [], screenshots: [] };
      } else if (!full) {
        smoke = { ok: true, status: "skipped", reason: "web-only package has no app/runtime to start", checks: [], screenshots: [] };
      } else {
        await advance(target, "smoke");
        log(`smoke ${target}: starting the packaged DSH under headless Chrome`);
        smoke = await runPackageSmoke({
          packageRoot: assembled.packageDir,
          target,
          workDir: path15.join(dir, "smoke", target),
          screenshotDir: path15.join(dir, "smoke", target),
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
      await advance(target, "end", { artifacts: [...artifacts] });
      if (smoke?.status === "failed") {
        throw Object.assign(
          new Error(`${target} smoke test failed: ${smoke.error ?? "see smoke.log"}`),
          { smokeFailure: true }
        );
      }
    };
    const queue = [...targets];
    let stopped = false;
    const worker = async () => {
      while (!stopped) {
        const target = queue.shift();
        if (target === void 0) return;
        try {
          await packageTarget(target);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failure ??= { message, smoke: error instanceof Error && error.smokeFailure === true };
          stopped = true;
          if (concurrency > 1) log(`${target} failed; letting the other target finish`);
          return;
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(concurrency, targets.length) },
      () => worker()
    ));
    artifacts.sort((left, right) => targets.indexOf(left.target) - targets.indexOf(right.target));
    if (failure !== null) {
      state = await updateState(dir, {
        status: failure.smoke ? "smoke-failed" : "failed",
        phase: failure.smoke ? "smoke" : "failed",
        percent: reported,
        error: failure.message,
        artifacts
      });
      if (failure.smoke) log(`smoke verification failed: ${failure.message}`);
      else log(`build failed: ${failure.message}`);
      return state;
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
  const recipesPath = options.recipesPath ?? path15.join(options.repositoryRoot, "build", "recipes.json");
  const overlayRoot = options.overlayRoot ?? path15.join(options.repositoryRoot, "build", "overlays");
  const state = await readState(dir);
  if (state.worktree === null) throw new Error("this job has no worktree yet");
  const recipes = await loadRecipes(recipesPath);
  const learned = await learnOverlays({
    worktree: state.worktree,
    recipes,
    overlayRoot,
    mismatches: Array.isArray(state.mismatches) ? state.mismatches : []
  });
  await writeFile8(recipesPath, JSON.stringify(learned.recipes, null, 2), "utf8");
  await appendLog(dir, `learned ${String(learned.learned.length)} overlay(s)`);
  return updateState(dir, { status: "learned", learnedAt: (/* @__PURE__ */ new Date()).toISOString(), learned: learned.learned });
}
async function readPluginVersion(repositoryRoot) {
  try {
    const parsed = JSON.parse(await readFile11(path15.join(repositoryRoot, "package.json"), "utf8"));
    return typeof parsed?.version === "string" && parsed.version.trim() !== "" ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}
async function readSourceVersion(worktree) {
  for (const candidate of [
    path15.join(worktree, "apps", "cli", "package.json"),
    path15.join(worktree, "package.json")
  ]) {
    try {
      const pkg = JSON.parse(await readFile11(candidate, "utf8"));
      if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
    } catch {
    }
  }
  return "0.0.0";
}

// code/deploy/engine.mjs
import { createHash as createHash4 } from "node:crypto";
import { createReadStream as createReadStream5 } from "node:fs";
import { spawn as spawn6 } from "node:child_process";
import { existsSync as existsSync10, readFileSync as readFileSync2 } from "node:fs";
import { copyFile as copyFile2, link as link2, mkdir as mkdir10, mkdtemp as mkdtemp5, readFile as readFile13, readdir as readdir6, rename as rename7, rm as rm11, stat as stat10, writeFile as writeFile9 } from "node:fs/promises";
import { isIP as isIP3 } from "node:net";
import { homedir as homedir2, hostname, tmpdir as tmpdir3 } from "node:os";
import path17 from "node:path";

// code/shared/egress.mjs
import { spawn as spawn5 } from "node:child_process";
import { existsSync as existsSync9 } from "node:fs";
import { readFile as readFile12, stat as stat9 } from "node:fs/promises";
import path16 from "node:path";
import { fileURLToPath } from "node:url";
var HERE = path16.dirname(fileURLToPath(import.meta.url));
function resolveEgressScript(start) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path16.join(current, "code", "shared", "egress-proxy.mjs");
    if (existsSync9(candidate)) return candidate;
    const parent = path16.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path16.resolve(start, "..", "..", "code", "shared", "egress-proxy.mjs");
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
    const child = spawn5("ssh", [...sshOptions(plan), targetOf(plan), command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    const child = spawn5("ssh", [...sshOptions(plan), targetOf(plan), "bash -s"], {
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
    const local = await readFile12(SCRIPT_PATH, "utf8");
    const info = await stat9(SCRIPT_PATH);
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
    { name: "dsh-wireguard-control.service", role: "control" },
    { name: "dsh-web-gate.service", role: "gate" }
  ],
  windows: [
    // The supervisor service owns the whole stack: it runs start-stack.ps1
    // (gate + interop) in the interactive session when it can, and in session 0
    // otherwise. The old split DSH-Web-App service duplicated the gate's own
    // DSH spawn and is removed by the deploy. The control panel is its own SCM
    // service so restarting the gateway never takes 51821 down with it.
    { name: "DSH-WireGuard-Control", role: "control" },
    { name: "DSH-Mesh", role: "gate" }
  ]
};
var ROLE_ORDER = { control: 0, dsh: 1, gate: 2 };
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function ps(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
function deployerModelRoute() {
  if (process.env.DSH_DEPLOY_SYNC_MODEL === "0") return null;
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path17.join(homedir2(), ".dsh");
  const file = path17.join(home, "profiles", "web", "cordis.patch.yml");
  if (!existsSync10(file)) return null;
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
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path17.join(homedir2(), ".dsh");
  const file = path17.join(home, ".credentials.yaml");
  return existsSync10(file) ? file : null;
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
    state: path17.join(dir, "job.json"),
    log: path17.join(dir, "deploy.log"),
    runner: path17.join(dir, "runner.json"),
    request: path17.join(dir, "request.json")
  };
}
async function writeDeployState(dir, state) {
  const file = path17.join(dir, "job.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir10(dir, { recursive: true });
  await writeFile9(tmp, `${JSON.stringify(state, null, 2)}
`, "utf8");
  await rename7(tmp, file);
}
async function readDeployState(dir) {
  try {
    const parsed = JSON.parse(await readFile13(path17.join(dir, "job.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
async function appendDeployLog(dir, line) {
  await mkdir10(dir, { recursive: true });
  await writeFile9(path17.join(dir, "deploy.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}
`, { encoding: "utf8", flag: "a" });
}
async function runnerStatus(dir) {
  const file = path17.join(dir, "runner.json");
  let runner = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      runner = JSON.parse(await readFile13(file, "utf8"));
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
    const hash = createHash4("sha256");
    const stream = createReadStream5(file);
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
  return text.replace(/[\\/]+$/u, "");
}
function inferRole(name) {
  const text = String(name).toLowerCase();
  if (text.includes("wireguard") || text.includes("wg-") || text.includes("control")) return "control";
  if (text.includes("gate")) return "gate";
  return "dsh";
}
function normalizeServices(input, os11) {
  const source = input === void 0 ? DEFAULT_SERVICES[os11] : input;
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
    return { name, role };
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
async function findLatestPackage(repositoryRoot, os11) {
  const dist = path17.join(repositoryRoot, "dist");
  const suffixes = os11 === "linux" ? [".7z", ".tar.gz", ".tgz", ".zip"] : [".7z", ".zip"];
  const prefix = `dsh-mesh-`;
  const marker = `-${os11 === "linux" ? "linux" : "win"}-`;
  const entries = await readdir6(dist).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.includes(marker)) continue;
    if (!suffixes.some((suffix) => entry.endsWith(suffix))) continue;
    const file = path17.join(dist, entry);
    const info = await stat10(file).catch(() => null);
    if (info?.isFile()) candidates.push({ file, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`no ${os11} package found in ${dist}; build one or pass --package`);
  }
  return candidates[0].file;
}
function layoutRootFor(appRoot, os11) {
  const root = normalizeInstallRoot(appRoot);
  if (root === "") return root;
  const separator = os11 === "linux" ? "/" : "\\";
  const parts = root.split(os11 === "linux" ? /\/+/u : /[\\/]+/u);
  const index = parts.lastIndexOf("releases");
  if (index > 0) {
    const prefix = parts.slice(0, index).join(separator);
    return /^[A-Za-z]:$/u.test(prefix) ? `${prefix}${separator}` : prefix;
  }
  return root;
}
function archiveSuffix(file) {
  const name = path17.basename(String(file ?? ""));
  if (name.toLowerCase().endsWith(SEVEN_ZIP_SUFFIX)) return SEVEN_ZIP_SUFFIX;
  if (name.endsWith(".tar.gz")) return ".tar.gz";
  if (name.endsWith(".tgz")) return ".tgz";
  const extension = path17.extname(name);
  return extension === "" ? SEVEN_ZIP_SUFFIX : extension;
}
function archiveNameFor(file, os11) {
  const text = String(file ?? "");
  return os11 === "windows" ? path17.win32.basename(text) : path17.posix.basename(text);
}
async function buildDeployPlan(options) {
  if (typeof options.host !== "string" || options.host.trim() === "") throw new Error("host is required");
  const os11 = normalizeOs(options.os ?? "linux");
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const onTarget = options.packageOnTarget !== null && typeof options.packageOnTarget === "object" ? options.packageOnTarget : null;
  const descriptor = options.packageDescriptor !== null && typeof options.packageDescriptor === "object" ? options.packageDescriptor : null;
  let packagePath = "";
  let packageInfo2 = null;
  let sha256 = "";
  let packageLocal = true;
  let packageKeep = false;
  if (onTarget !== null) {
    packagePath = typeof onTarget.path === "string" ? onTarget.path.trim() : "";
    const bytes = Number(onTarget.bytes);
    sha256 = typeof onTarget.sha256 === "string" ? onTarget.sha256.trim().toLowerCase() : "";
    if (packagePath === "") throw new Error("packageOnTarget.path is required");
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("packageOnTarget.bytes must be a positive integer");
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("packageOnTarget.sha256 must be a 64-character hex digest");
    packageInfo2 = { size: bytes };
    packageKeep = onTarget.keep === true;
  } else if (descriptor !== null) {
    packagePath = typeof descriptor.name === "string" ? descriptor.name.trim() : "";
    const bytes = Number(descriptor.bytes);
    sha256 = typeof descriptor.sha256 === "string" ? descriptor.sha256.trim().toLowerCase() : "";
    if (packagePath === "" || packagePath !== path17.basename(packagePath)) throw new Error("packageDescriptor.name must be an archive name");
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("packageDescriptor.bytes must be a positive integer");
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("packageDescriptor.sha256 must be a 64-character hex digest");
    packageInfo2 = { size: bytes };
    packageLocal = descriptor.local !== false;
  } else if (options.skipPackage !== true) {
    packagePath = options.package ? path17.resolve(options.package) : await findLatestPackage(repositoryRoot, os11);
    packageInfo2 = await stat10(packagePath);
    if (!packageInfo2.isFile()) throw new Error(`package is not a file: ${packagePath}`);
    sha256 = await hashFile(packagePath);
  }
  const release = options.skipPackage === true ? "rollback" : typeof options.release === "string" && options.release.trim() !== "" ? options.release.trim() : `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${sha256.slice(0, 8)}`;
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(release)) {
    throw new Error("release must be 3-80 chars of letters, digits, dot, underscore or dash");
  }
  const appRoot = normalizeInstallRoot(options.appRoot) || DEFAULT_APP_ROOT[os11];
  const layoutRoot = layoutRootFor(appRoot, os11);
  const archiveName = archiveNameFor(packagePath, os11);
  const packageArch = /-(arm64|x64)\.(?:7z|tgz|tar\.gz|zip)$/u.exec(archiveName)?.[1] ?? "x64";
  const wantsSevenZip = archiveName.toLowerCase().endsWith(SEVEN_ZIP_SUFFIX);
  const sevenZip = wantsSevenZip ? {
    file: sevenZipAssetFile(os11, packageArch),
    // The plugin inside an installed release does not own `code/gate`; the
    // resolver checks the release's `gate/assets/7z` as well.
    local: resolveSevenZipAssetPath(repositoryRoot, os11, packageArch),
    remote: os11 === "linux" ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}-7z.bin` : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}-7z.exe`
  } : null;
  const services = normalizeServices(options.services, os11);
  const scope = options.scope === "dsh" ? "dsh" : "all";
  const gatePort = String(options.gatePort ?? "80");
  if (!/^\d{1,5}$/.test(gatePort) || Number(gatePort) > 65535) throw new Error("gatePort is invalid");
  const retention = 2;
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
    identityFile: typeof options.identityFile === "string" && options.identityFile.trim() !== "" ? path17.resolve(options.identityFile) : void 0,
    os: os11,
    package: {
      path: packagePath,
      archive: archiveNameFor(packagePath, os11),
      bytes: packageInfo2?.size ?? 0,
      sha256,
      local: packageLocal,
      keep: packageKeep,
      onTarget: onTarget !== null
    },
    // The archive is already on the target, so upload/download must be skipped
    // and the target path doubles as `remotePackage`.
    packageOnTarget: onTarget !== null,
    release,
    appRoot,
    layoutRoot,
    serviceUser,
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
    // The 7-Zip binary uploaded for a .7z package (null for legacy archives).
    sevenZip,
    // Named by content, not by release, so a retried deploy of the same package
    // reuses the upload instead of pushing hundreds of megabytes again.
    remotePackage: onTarget !== null ? packagePath : os11 === "linux" ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}${archiveSuffix(packagePath)}` : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}${archiveSuffix(packagePath)}`,
    // A test upgrade rehearses the *flat* upgrade (the path the gateway uses
    // on itself) in a sandbox on the member before touching it, then runs the
    // normal blue-green upgrade. Without this a member test proves nothing
    // about the local path.
    test: options.test === true,
    // The deployer's account grants travel with the deploy so a fresh member
    // needs no QR scan of its own.
    remoteCredentials: os11 === "linux" ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}.account` : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}.account`,
    // When the gateway has a release configured, an upgrade may fetch the
    // archive on the member instead of receiving it through the gateway. The
    // plan carries only URLs and the proxy's SSH coordinates; tokens never
    // leave the gateway.
    download: options.download === null || options.download === void 0 ? null : options.download
  };
}
async function probeTarget(options) {
  if (typeof options.host !== "string" || options.host.trim() === "") throw new Error("host is required");
  const os11 = normalizeOs(options.os ?? "linux");
  const user = typeof options.user === "string" && options.user.trim() !== "" ? options.user.trim() : void 0;
  const plan = {
    host: options.host.trim(),
    user,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === "string" && options.identityFile.trim() !== "" ? path17.resolve(options.identityFile) : void 0,
    os: os11
  };
  const runner = new SshRunner(plan);
  if (os11 === "windows") {
    const script2 = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$svc = Get-CimInstance Win32_Service -Filter "Name='DSH-Mesh'"`,
      "$root = ''",
      "if ($svc -and $svc.PathName) {",
      `  if ($svc.PathName -match '^"([^"]+)"') { $exe = $matches[1] } else { $exe = ($svc.PathName -split ' ')[0] }`,
      "  $root = Split-Path -Parent $exe",
      "}",
      "if (-not $root) { $root = Join-Path $env:USERPROFILE '.dsh' }",
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
    const appRoot = normalizeInstallRoot(root2) !== "" ? normalizeInstallRoot(root2) : `C:\\Users\\${user ?? "Public"}\\.dsh`;
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
  root="\${HOME:-/root}/.dsh"
fi
printf '%s\\n%s\\n' "$root" "$runuser"
`;
  const { stdout } = await runner.runProcess("ssh", [
    ...runner.sshOptions(),
    runner.target(),
    "bash -s"
  ], script);
  const [root = "", serviceUser = ""] = stdout.split(/\r?\n/u);
  const fallback = user !== void 0 && user !== "root" ? `/home/${user}/.dsh` : "/root/.dsh";
  return {
    appRoot: root.trim() !== "" ? root.trim() : fallback,
    serviceUser: serviceUser.trim() !== "" ? serviceUser.trim() : void 0
  };
}
function buildLinuxPrepareScript(plan) {
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
  const wgPersist = `for conf in /etc/wireguard/*.conf; do
  [ -f "$conf" ] || continue
  grep -q '^# Managed by the dsh-wireguard client bootstrap' "$conf" || continue
  iface=$(basename "$conf" .conf)
  systemctl enable "wg-quick@$iface" >/dev/null 2>&1 || true
  echo "wg-quick@$iface enabled for boot"
done
`;
  return `#!/usr/bin/env bash
set -euo pipefail
LAYOUT_ROOT=${sh(plan.layoutRoot)}
STAGE="$LAYOUT_ROOT/.staging/${plan.release}"
PACKAGE=${sh(plan.remotePackage)}
[ -f "$PACKAGE" ] || { echo "package is missing: $PACKAGE" >&2; exit 1; }
rm -rf "$STAGE"
mkdir -p "$STAGE" "$LAYOUT_ROOT/releases"
# One marker per ${String(EXTRACT_CHECKPOINT)} extracted entries: the deploy engine turns
# these into the panel's extraction progress. A .7z package is unpacked with
# the bundled 7-Zip the deploy uploaded; the legacy formats still use tar so a
# package built before the switch keeps installing.
case "$PACKAGE" in
  *.7z)
    SEVENZIP=${sh(plan.sevenZip?.remote ?? "")}
    [ -n "$SEVENZIP" ] && [ -f "$SEVENZIP" ] || { echo "7-Zip binary is missing: $SEVENZIP" >&2; exit 1; }
    chmod +x "$SEVENZIP" 2>/dev/null || true
    TOTAL=$("$SEVENZIP" l -ba "$PACKAGE" 2>/dev/null | wc -l | tr -d ' ')
    printf 'DSH-MESH-EXTRACT-TOTAL %s\\n' "$TOTAL"
    # 7-Zip reports status 2 when it refuses a link but still extracts every
    # other entry; the links it refused are recreated below, so only a real
    # archive error may abort here (the node --check at the end is the proof
    # the tree is complete).
    set +e
    "$SEVENZIP" x -y -bd -o"$STAGE" "$PACKAGE" >/dev/null
    SEVENZIP_STATUS=$?
    set -e
    if [ "$SEVENZIP_STATUS" -ne 0 ] && [ "$SEVENZIP_STATUS" -ne 2 ]; then echo "7-Zip extraction failed ($SEVENZIP_STATUS)" >&2; exit "$SEVENZIP_STATUS"; fi
    # 7-Zip keeps the package's own top-level directory; the rest of the deploy
    # expects the tree to start at the staging root.
    for inner in "$STAGE"/dsh-mesh-*; do
      [ -d "$inner" ] || continue
      [ -f "$inner/manifest.json" ] || continue
      ( shopt -s dotglob nullglob; mv "$inner"/* "$STAGE"/ )
      rmdir "$inner" 2>/dev/null || true
      break
    done
    printf 'DSH-MESH-EXTRACT %s\\n' "$TOTAL"
    ;;
  *)
    printf 'DSH-MESH-EXTRACT-TOTAL %s\\n' "$(tar -tzf "$PACKAGE" | wc -l | tr -d ' ')"
    tar -xzf "$PACKAGE" -C "$STAGE" --strip-components=1 -v | {
      extracted=0
      while IFS= read -r _entry; do
        extracted=$((extracted + 1))
        if [ $((extracted % ${String(EXTRACT_CHECKPOINT)})) -eq 0 ]; then printf 'DSH-MESH-EXTRACT %s\\n' "$extracted"; fi
      done
    }
    ;;
esac
# The archive is 300+ MiB and /tmp is often a small tmpfs; a temp copy is
# deleted after extraction. A package chosen from the member's own cache is
# not a temp copy and is kept.
${plan.package?.keep === true ? "# keep the package: it was selected from the member's own cache" : 'rm -f "$PACKAGE"'}
chmod +x "$STAGE"/*.sh "$STAGE/dsh-mesh.mjs" 2>/dev/null || true
# A 7-Zip archive created on Windows carries no Unix mode bits, so every script
# and the bundled node are made executable explicitly instead of trusting the
# extraction. The 7-Zip asset itself is needed again by a future deploy.
find "$STAGE" -type f -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
chmod +x "$STAGE/runtime/node/bin/node" 2>/dev/null || true
chmod +x "$STAGE"/code/gate/assets/7z/7zz-* 2>/dev/null || true
# 7-Zip refuses any link whose target contains '..' (the node runtime's
# npm/npx/corepack shims do) and leaves an empty file in its place. Recreate
# them from the runtime layout, only when the file is empty and the target
# really exists \u2014 a Windows-built package carries no Unix mode, so these are
# the only symlinks a package needs.
NODE_BIN="$STAGE/runtime/node/bin"
if [ -d "$STAGE/runtime/node/lib/node_modules" ] && [ -d "$NODE_BIN" ]; then
  for link in npm:npm/bin/npm-cli.js npx:npm/bin/npx-cli.js corepack:corepack/dist/corepack.js; do
    link_name=\${link%%:*}
    link_target=\${link#*:}
    if [ -f "$NODE_BIN/$link_name" ] && [ ! -s "$NODE_BIN/$link_name" ] && [ -f "$STAGE/runtime/node/lib/node_modules/$link_target" ]; then
      ln -sfn "../lib/node_modules/$link_target" "$NODE_BIN/$link_name"
      printf 'DSH-MESH-LINK %s\\n' "$link_name"
    fi
  done
fi
NODE="$STAGE/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "the package has no usable node" >&2; exit 1; }
"$NODE" --check "$STAGE/gate/server.mjs"
${netTune}${wgPersist}echo "prepared ${plan.release} at $STAGE"
`;
}
function buildLinuxActivateScript(plan) {
  const serviceList = plan.services.map((service) => `${service.name}=${service.role}`).join(",");
  const interop = plan.interop === null || plan.interop === void 0 ? "" : ` --interop-bind ${sh(plan.interop.bind)} --interop-port ${sh(String(plan.interop.port))} --interop-provider ${sh(plan.interop.provider)} --interop-model ${sh(plan.interop.model)}`;
  const credentials = typeof plan.remoteCredentials === "string" && plan.remoteCredentials !== "" ? ` --credentials ${sh(plan.remoteCredentials)}` : "";
  const llm = plan.llm === null || plan.llm === void 0 ? "" : ` --llm-provider ${sh(plan.llm.provider)}${plan.llm.model ? ` --llm-model ${sh(plan.llm.model)}` : ""}${plan.llm.reasoningEffort ? ` --llm-effort ${sh(plan.llm.reasoningEffort)}` : ""}`;
  return `#!/usr/bin/env bash
set -euo pipefail
LAYOUT_ROOT=${sh(plan.layoutRoot)}
STAGE="$LAYOUT_ROOT/.staging/${plan.release}"
[ -f "$STAGE/manifest.json" ] || { echo "prepare did not leave $STAGE behind" >&2; exit 1; }
NODE="$STAGE/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo 'no usable node on the target' >&2; exit 1; }
exec "$NODE" "$STAGE/code/deploy/upgrade-local.mjs"   --stage "$STAGE"   --layout-root "$LAYOUT_ROOT"   --release ${sh(plan.release)}   --port ${sh(plan.gatePort)}   --gate-port ${sh(plan.gatePort)}   --gate-password ${sh(plan.gatePassword || "")}   --services ${sh(serviceList)}${interop}${credentials}${llm}
`;
}
function buildLinuxRehearseScript() {
  return `#!/usr/bin/env bash
set -euo pipefail
echo 'test upgrade is retired: the pointer layout rehearses on every real upgrade and rolls back on failure' >&2
exit 3
`;
}
function buildLinuxRollbackScript(plan) {
  return `#!/usr/bin/env bash
set -euo pipefail
LAYOUT_ROOT=${sh(plan.layoutRoot)}
[ -f "$LAYOUT_ROOT/rollback-local.mjs" ] || { echo "no rollback orchestrator at $LAYOUT_ROOT/rollback-local.mjs" >&2; exit 1; }
NODE="$LAYOUT_ROOT/runtime/node/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node || true)
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo 'no usable node on the target' >&2; exit 1; }
exec "$NODE" "$LAYOUT_ROOT/rollback-local.mjs" --root "$LAYOUT_ROOT"
`;
}
function buildWindowsPrepareScript(plan) {
  return `$ErrorActionPreference = 'Stop'
$LayoutRoot = ${ps(plan.layoutRoot)}
$Stage = Join-Path $LayoutRoot ${ps(`.staging\\${plan.release}`)}
$Package = ${ps(plan.remotePackage)}
Write-Output "layout root $LayoutRoot"
New-Item -ItemType Directory -Force -Path $LayoutRoot, (Join-Path $LayoutRoot 'releases') | Out-Null
if (-not (Test-Path -LiteralPath $Stage)) {
  if (-not (Test-Path -LiteralPath $Package)) { throw "package is missing: $Package" }
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null
  if ($Package -like '*.7z') {
    $SevenZip = ${ps(plan.sevenZip?.remote ?? "")}
    if (-not (Test-Path -LiteralPath $SevenZip)) { throw "7-Zip binary is missing: $SevenZip" }
    & $SevenZip x -y -bd ("-o" + $Stage) $Package | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '7-Zip extraction failed' }
  } else {
    Expand-Archive -LiteralPath $Package -DestinationPath $Stage -Force
    if ($LASTEXITCODE -ne 0) { throw 'Expand-Archive failed' }
  }
}
$inner = Get-ChildItem -LiteralPath $Stage -Directory | Select-Object -First 1
if ($inner -and (Test-Path (Join-Path $inner.FullName 'manifest.json'))) {
  Get-ChildItem -LiteralPath $inner.FullName -Force | Move-Item -Destination $Stage -Force
  Remove-Item -LiteralPath $inner.FullName -Recurse -Force
}
if (-not (Test-Path (Join-Path $Stage 'dsh-mesh.mjs'))) { throw 'package is missing dsh-mesh.mjs' }
$node = Join-Path $Stage 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
& $node --check (Join-Path $Stage 'gate\\server.mjs')
if ($LASTEXITCODE -ne 0) { throw 'gate/server.mjs failed node --check' }
# One 300\u2013420 MiB archive per upgrade must not pile up in the temp directory.
# A staging archive is deleted after extraction; a package chosen from the
# member's own cache is kept.
$KeepPackage = ${plan.package?.keep === true ? "$true" : "$false"}
if (-not $KeepPackage) { Remove-Item -LiteralPath $Package -Force -ErrorAction SilentlyContinue }
Write-Output "prepared ${plan.release} at $Stage"
`;
}
function buildWindowsActivateScript(plan) {
  const serviceList = plan.services.map((service) => `${service.name}=${service.role}`).join(",");
  const interop = plan.interop === null || plan.interop === void 0 ? "" : ` --interop-bind ${ps(plan.interop.bind)} --interop-port ${ps(String(plan.interop.port))} --interop-provider ${ps(plan.interop.provider)} --interop-model ${ps(plan.interop.model)}`;
  const credentials = typeof plan.remoteCredentials === "string" && plan.remoteCredentials !== "" ? ` --credentials ${ps(plan.remoteCredentials)}` : "";
  const llm = plan.llm === null || plan.llm === void 0 ? "" : ` --llm-provider ${ps(plan.llm.provider)}${plan.llm.model ? ` --llm-model ${ps(plan.llm.model)}` : ""}${plan.llm.reasoningEffort ? ` --llm-effort ${ps(plan.llm.reasoningEffort)}` : ""}`;
  return `$ErrorActionPreference = 'Stop'
$LayoutRoot = ${ps(plan.layoutRoot)}
$Stage = Join-Path $LayoutRoot ${ps(`.staging\\${plan.release}`)}
$ReleaseDir = Join-Path (Join-Path $LayoutRoot 'releases') ${ps(plan.release)}
# Before the switch the package lives in $Stage, so that is where the staged
# node and the upgrade entry point are.
$stageNode = Join-Path $Stage 'runtime\\node\\node.exe'
if (-not (Test-Path $stageNode)) { $stageNode = (Get-Command node -ErrorAction Stop).Source }
$port = ${ps(plan.gatePort)}
& $stageNode (Join-Path $Stage 'code\\deploy\\upgrade-local.mjs') --stage $Stage --layout-root $LayoutRoot --release ${ps(plan.release)} --port $port --gate-port $port --gate-password ${ps(plan.gatePassword || "")} --services ${ps(serviceList)}${interop}${credentials}${llm} --no-restart
if ($LASTEXITCODE -ne 0) { throw "pointer switch failed (exit $LASTEXITCODE)" }
# upgrade-local.mjs moved the staging tree into $ReleaseDir (and deleted it on
# a rename), so nothing below may resolve through the staging path. Keep a node
# that survives the move: the layout's stable runtime, then the release copy.
$node = Join-Path $LayoutRoot 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { $node = Join-Path $ReleaseDir 'runtime\\node\\node.exe' }
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
# The pointer now names the new release and the root code junction points at
# it. Read the installer there (never from the stage) and roll back when it is
# missing instead of leaving a half-switched install with an old service.
$installer = Join-Path $LayoutRoot 'code\\windows-service\\install-service.ps1'
if (-not (Test-Path $installer)) { $installer = Join-Path $ReleaseDir 'code\\windows-service\\install-service.ps1' }
if (-not (Test-Path $installer)) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a missing service installer also failed' }
  throw "missing $installer"
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Root $LayoutRoot
if ($LASTEXITCODE -ne 0) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a failed service install also failed' }
  throw 'service installation failed after the pointer switch; rolled back'
}
# The control panel is a per-member service, not a gateway extra: register it
# against the stable layout root and let the launcher pick the active release,
# so an upgrade never leaves 51821 pointing at a release that is about to go.
# The stage may already be gone (a successful rename moves it into releases/),
# so read the installer through the stable code junction when it exists.
$controlInstaller = Join-Path $LayoutRoot 'code\\wireguard\\windows-service\\install-control-service.ps1'
if (-not (Test-Path $controlInstaller)) { $controlInstaller = Join-Path $ReleaseDir 'code\\wireguard\\windows-service\\install-control-service.ps1' }
if (-not (Test-Path $controlInstaller)) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a missing control panel installer also failed' }
  throw 'missing the control panel installer in the new release'
}
$stableNode = Join-Path $LayoutRoot 'runtime\\node\\node.exe'
if (-not (Test-Path $stableNode)) { $stableNode = Join-Path $ReleaseDir 'runtime\\node\\node.exe' }
if (-not (Test-Path $stableNode)) { $stableNode = $node }
$dshHome = Join-Path $LayoutRoot 'shared\\home'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controlInstaller -Root $LayoutRoot -NodePath $stableNode -DshHome $dshHome
if ($LASTEXITCODE -ne 0) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a failed control panel install also failed' }
  throw 'control panel installation failed after the pointer switch; rolled back'
}
$deadline = (Get-Date).AddSeconds(180)
$gateHealthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/__gate/health") -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $gateHealthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if (-not $gateHealthy) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a failed health check also failed' }
  throw 'gateway health check failed after the pointer switch; rolled back'
}
$controlDeadline = (Get-Date).AddSeconds(120)
$controlHealthy = $false
while ((Get-Date) -lt $controlDeadline) {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:51821/api/dsh-wireguard/health' -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $controlHealthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if (-not $controlHealthy) {
  & $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
  if ($LASTEXITCODE -ne 0) { Write-Output 'rollback after a failed control panel health check also failed' }
  throw 'control panel health check on 51821 failed after the pointer switch; rolled back'
}
Write-Output 'gateway and control panel are healthy'
`;
}
function buildWindowsRollbackScript(plan) {
  return `$ErrorActionPreference = 'Stop'
$LayoutRoot = ${ps(plan.layoutRoot)}
$node = Join-Path $LayoutRoot 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
& $node (Join-Path $LayoutRoot 'rollback-local.mjs') --root $LayoutRoot
if ($LASTEXITCODE -ne 0) { throw 'rollback failed' }
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
      plan.packageOnTarget === true ? `use the package already on the target (${plan.package.path}); no download or upload` : `obtain ${plan.package.archive ?? path17.basename(plan.package.path)}: download from the release when configured, else upload to ${plan.remotePackage}`,
      `extract and prepare ${plan.layoutRoot}/.staging/${plan.release} (no service switch)`,
      `update shared config and service definitions for ${plan.layoutRoot}`,
      `switch the pointer to ${plan.release}`,
      ...plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `restart ${service.name} (${service.role})`),
      `health check http://127.0.0.1:${plan.gatePort}/__gate/health`,
      ...plan.services.some((service) => service.role === "control") ? ["health check http://127.0.0.1:51821/api/dsh-wireguard/health"] : [],
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
    const totalBytes = (await stat10(local)).size;
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
   * Count the entries in a remote 7-Zip archive.
   * @param {string} remote remote archive path.
   * @param {string} sevenZip remote 7-Zip binary path.
   * @returns {Promise<number>} entry count.
   */
  async sevenZipEntries(remote, sevenZip) {
    const command = this.plan.os === "windows" ? `"${sevenZip}" l -ba "${remote}"` : `${sh(sevenZip)} l -ba ${sh(remote)}`;
    const { stdout } = await this.runProcess("ssh", [...this.sshOptions(), this.target(), command]);
    return String(stdout).split(/\r?\n/u).filter((line) => line.trim() !== "").length;
  }
  /**
   * Extract a remote 7-Zip archive.
   * @param {string} remote remote archive path.
   * @param {string} target remote directory.
   * @param {string} sevenZip remote 7-Zip binary path.
   * @returns {Promise<void>}
   */
  async extractSevenZip(remote, target, sevenZip) {
    if (this.plan.os === "windows") {
      await this.runProcess("ssh", [...this.sshOptions(), this.target(), `cmd /c if not exist "${target}" mkdir "${target}"`]);
      await this.runProcess("ssh", [...this.sshOptions(), this.target(), `"${sevenZip}" x -y -bd -o"${target}" "${remote}"`]);
      return;
    }
    await this.runProcess("ssh", [...this.sshOptions(), this.target(), `mkdir -p ${sh(target)} && ${sh(sevenZip)} x -y -bd -o${sh(target)} ${sh(remote)}`]);
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
      const dir = path17.posix.dirname(remote);
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
    const dir = path17.posix.dirname(remote);
    const keep = path17.posix.basename(remote);
    const script = [
      `cd ${sh(dir)} 2>/dev/null || exit 0`,
      "for f in dsh-mesh-*.7z dsh-mesh-*.gz dsh-mesh-*.tar.gz dsh-mesh-*.zip dsh-mesh-*-7z.bin; do",
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
    const remoteCommand = windows ? `tar -xf - -C "${path17.win32.dirname(remote)}"` : `cat > ${sh(remote)}`;
    const args = [...this.sshOptions(), this.target(), remoteCommand];
    let tarDir = null;
    let tarName = null;
    if (windows) {
      tarName = path17.win32.basename(remote);
      tarDir = await mkdtemp5(path17.join(tmpdir3(), "dsh-mesh-upload-"));
      const staged = path17.join(tarDir, tarName);
      try {
        try {
          await link2(local, staged);
        } catch {
          await copyFile2(local, staged);
        }
      } catch (error) {
        await rm11(tarDir, { recursive: true, force: true }).catch(() => {
        });
        throw error;
      }
    }
    return new Promise((resolve, reject) => {
      const ssh = spawn6("ssh", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const tar = windows ? spawn6("tar", ["-cf", "-", "-C", tarDir, tarName], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : null;
      const source = tar !== null ? tar.stdout : createReadStream5(local);
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
        if (tarDir !== null) void rm11(tarDir, { recursive: true, force: true }).catch(() => {
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
      const child = spawn6(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
  async script(script, os11, onLine) {
    const base = this.sshOptions();
    if (os11 === "linux") {
      const remote = this.plan.sudo ? "sudo -n bash -s" : "bash -s";
      await this.runProcess("ssh", [...base, this.target(), remote], script, onLine);
      return;
    }
    const name = `dsh-deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.ps1`;
    const remotePath = `C:\\Windows\\Temp\\${name}`;
    const localPath = path17.join(tmpdir3(), name);
    await writeFile9(localPath, `\uFEFF${script}`, "utf8");
    try {
      await this.upload(localPath, remotePath);
      await this.runProcess(
        "ssh",
        [...base, this.target(), `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remotePath}"`],
        void 0,
        onLine
      );
    } finally {
      await rm11(localPath, { force: true }).catch(() => {
      });
      await this.runProcess("ssh", [...base, this.target(), `cmd /c del /f "${remotePath}"`]).catch(() => {
      });
    }
  }
};
function runLocalProcess(command, args, input, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn6(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
    const info = await stat10(local);
    await mkdir10(path17.dirname(remote), { recursive: true });
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
      const info = await stat10(remote);
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
  async script(script, os11, onLine) {
    if (os11 !== "linux") throw new Error("\u672C\u5730\u90E8\u7F72\u53EA\u652F\u6301 Linux\uFF1A\u672C\u673A\u6CA1\u6709\u53EF\u7528\u7684 Windows \u8FD0\u884C\u65F6");
    await runLocalProcess("bash", ["-s"], script, onLine);
  }
};
function linuxNodeProbeScript(appRoot) {
  const root = String(appRoot ?? "").replace(/[\\/]+$/u, "");
  const candidates = [
    ...root === "" ? [] : [`${root}/runtime/node/bin/node`, `${root}/runtime/node/node`],
    "$HOME/.dsh/runtime/node/bin/node",
    "$HOME/.dsh/runtime/node/node"
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
  const quoted = root === "" ? [] : [ps(`${root}\\runtime\\node\\node.exe`)];
  const candidates = [
    ...quoted,
    "(Join-Path $env:USERPROFILE '.dsh\\runtime\\node\\node.exe')"
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
  const archive = plan.package.archive ?? path17.basename(plan.package.path);
  const prefer = options.prefer === "gitee" ? "--prefer gitee" : "";
  const manifestArgs = options.manifests.map((entry) => `--manifest-${entry.provider} ${plan.os === "windows" ? ps(entry.url) : sh(entry.url)}`).join(" ");
  if (plan.os === "windows") {
    const script2 = `${options.remoteDir}\\deploy\\release-download.mjs`;
    const args2 = [
      manifestArgs,
      `--archive ${ps(archive)}`,
      `--sha256 ${ps(plan.package.sha256)}`,
      `--output ${ps(plan.remotePackage)}`,
      options.proxyUrl === null ? "" : `--proxy ${ps(options.proxyUrl)}`,
      `--workdir ${ps(`${options.remoteDir}\\parts`)}`,
      prefer
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
    `--workdir ${sh(`${options.remoteDir}/parts`)}`,
    prefer
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
function cancelCleanupScript(plan) {
  if (plan === null || typeof plan !== "object") return null;
  const os11 = plan.os === "windows" ? "windows" : "linux";
  const targets = [];
  const release = String(plan.release ?? "");
  const layoutRoot = String(plan.layoutRoot ?? "");
  if (/^[A-Za-z0-9._-]{3,80}$/u.test(release) && layoutRoot !== "") {
    targets.push(os11 === "windows" ? `${layoutRoot}\\.staging\\${release}` : `${layoutRoot}/.staging/${release}`);
  }
  const sha12 = String(plan.package?.sha256 ?? "").slice(0, 12);
  if (/^[a-f0-9]{12}$/u.test(sha12)) {
    targets.push(os11 === "windows" ? `C:\\Windows\\Temp\\dsh-mesh-release-${sha12}` : `/tmp/dsh-mesh-release-${sha12}`);
  }
  const inTemp = (value, prefix) => typeof value === "string" && value !== "" && (os11 === "windows" ? value.toLowerCase().startsWith(prefix.toLowerCase()) : value.startsWith(prefix));
  const tempPrefix = os11 === "windows" ? "C:\\Windows\\Temp\\dsh-mesh-" : "/tmp/dsh-mesh-";
  if (plan.packageOnTarget !== true && inTemp(plan.remotePackage, tempPrefix)) targets.push(plan.remotePackage);
  if (inTemp(plan.remoteCredentials, tempPrefix)) targets.push(plan.remoteCredentials, `${plan.remoteCredentials}.mjs`);
  if (targets.length === 0) return null;
  const script = os11 === "windows" ? [
    "$ErrorActionPreference = 'SilentlyContinue'",
    ...targets.map((target) => `Remove-Item -LiteralPath ${ps(target)} -Recurse -Force -ErrorAction SilentlyContinue`),
    "exit 0"
  ].join("\n") : [
    "set +e",
    ...targets.map((target) => `rm -rf -- ${sh(target)}`),
    "exit 0"
  ].join("\n");
  return { os: os11, script };
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
async function terminateProcess(pid) {
  if (!pidAlive(pid)) return false;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!pidAlive(pid)) return true;
    await delay(100);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!pidAlive(pid)) return true;
    await delay(100);
  }
  return false;
}
function runCommandQuiet(command, args, timeoutMs = 2e4) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn6(command, args, { stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
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
    const dir = path17.join(this.dataDir, id);
    await mkdir10(dir, { recursive: true });
    const stateFile = path17.join(dir, "job.json");
    const logFile = path17.join(dir, "deploy.log");
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
      packageOnTarget: plan.packageOnTarget === true,
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
      await writeFile9(logFile, `[${stamp}] ${line}
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
      if (plan.packageOnTarget === true) {
        if (existingBytes !== plan.package.bytes) {
          throw new Error(`\u7F16\u8BD1\u673A\u4E0A\u7684\u5B89\u88C5\u5305\u4E0D\u53EF\u7528\uFF1A${plan.package.path} ${existingBytes === null ? "\u4E0D\u5B58\u5728" : `\u53EA\u6709 ${formatBytes2(existingBytes)}\uFF0C\u5E94\u4E3A ${formatBytes2(plan.package.bytes)}`}`);
        }
        const localLabel = plan.package.keep === true ? "\u76EE\u6807\u6210\u5458\u672C\u5730\u5305" : "\u7F16\u8BD1\u673A\u672C\u5730\u5305";
        meter(`\u4F7F\u7528${localLabel}`, { bytes: existingBytes, totalBytes: plan.package.bytes, percent: 100 });
        await mark("upload", "succeeded", `${formatBytes2(existingBytes)} \xB7 ${localLabel}\uFF0C\u8DF3\u8FC7\u4E0B\u8F7D/\u4E0A\u4F20`);
        await log(`using the package already on the target (${plan.package.path}), skipping download and upload`);
      } else if (existingBytes === plan.package.bytes) {
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
          if (plan.package.local === false) {
            throw Object.assign(
              new Error("Release \u4E0B\u8F7D\u5931\u8D25\uFF0C\u4E14\u7F51\u5173\u6CA1\u6709\u8FD9\u4E2A\u5305\u7684\u672C\u5730\u526F\u672C\uFF1B\u8BF7\u6539\u7528\u300C\u76EE\u6807\u6210\u5458\u5DF2\u6709\u5305\u300D\uFF0C\u6216\u628A\u5305\u653E\u5230\u672C\u673A ~/.dsh/packages \u540E\u91CD\u8BD5"),
              { code: "release_download_failed" }
            );
          }
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
      if (plan.sevenZip !== null && plan.sevenZip !== void 0) {
        if (!existsSync10(plan.sevenZip.local)) {
          throw new Error(`bundled 7-Zip binary is missing: ${plan.sevenZip.local} (${plan.sevenZip.file})`);
        }
        await log(`uploading 7-Zip (${plan.sevenZip.file}) for package extraction`);
        await runner.upload(plan.sevenZip.local, plan.sevenZip.remote);
      }
      const credentialsFile = deployerCredentialsFile();
      if (credentialsFile !== null) {
        try {
          await runner.upload(credentialsFile, plan.remoteCredentials);
          const helperFile = path17.join(this.repositoryRoot, "code", "shared", "credentials-merge.mjs");
          if (existsSync10(helperFile)) await runner.upload(helperFile, `${plan.remoteCredentials}.mjs`);
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
      if (plan.os === "windows" && plan.sevenZip !== null && plan.sevenZip !== void 0 && typeof runner.sevenZipEntries === "function") {
        const newDir = `${plan.layoutRoot}\\.staging\\${plan.release}`;
        const total = await runner.sevenZipEntries(plan.remotePackage, plan.sevenZip.remote).catch(() => 0);
        if (total > 0) {
          await log(`extracting ${total} archive entries with 7-Zip`);
          await runner.extractSevenZip(plan.remotePackage, newDir, plan.sevenZip.remote);
          extractProgress(total, total, true);
          preExtracted = true;
        }
      } else if (plan.os === "windows" && typeof runner.archiveEntries === "function" && typeof runner.extractArchive === "function") {
        const newDir = `${plan.layoutRoot}\\.staging\\${plan.release}`;
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
      await log("activate: switch the pointer, restart services with the gateway last");
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
      const localDownloader = path17.join(this.repositoryRoot, "code", "deploy", "release-download.mjs");
      const localClient = path17.join(this.repositoryRoot, "code", "shared", "http-client.mjs");
      if (!existsSync10(localDownloader) || !existsSync10(localClient)) {
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
        if (download2.proxy.kind === "link" && typeof download2.proxy.url === "string" && download2.proxy.url !== "") {
          proxyUrl = download2.proxy.url;
          await log(`release download through direct link ${download2.proxy.name ?? ""} (${proxyUrl}); Gitee is fetched directly`);
        } else {
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
        }
      } else if (download2.proxy !== null && typeof download2.proxy === "object") {
        await log("release download has only Gitee manifests; the proxy is not used");
      } else {
        await log("release download has no proxy configured; GitHub and Gitee are both fetched directly");
      }
      meter("\u4ECE Release \u4E0B\u8F7D\u5B89\u88C5\u5305", { percent: 0, indeterminate: true });
      if (download2.prefer === "gitee") {
        await log("release download prefers Gitee; GitHub is the fallback (and may use the proxy)");
      }
      const script = releaseDownloadScript(plan, { node, remoteDir, manifests, proxyUrl, prefer: download2.prefer });
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
      await log(`release download did not produce a usable package (${failure ?? `size ${String(landed)} instead of ${String(plan.package.bytes)}`}); ${plan.package.local === false ? "there is no local copy to upload" : "falling back to a gateway upload"}`);
      return false;
    } catch (error) {
      await log(`release download failed (${error instanceof Error ? error.message : String(error)}); ${plan.package.local === false ? "there is no local copy to upload" : "falling back to a gateway upload"}`);
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
      await writeFile9(tmp, text, "utf8");
      await rename7(tmp, stateFile);
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
    const dir = path17.join(this.dataDir, state.id);
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
    await this.#save(path17.join(dir, "job.json"), state).catch(() => {
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
   * Stop one queued or running deployment job and clean up its leftovers.
   *
   * The panel starts every job in a detached runner, so cancelling means
   * stopping that process (and its systemd transient unit), then removing only
   * what this job created: the staging tree, the downloader's temp directory,
   * the temporary archive, the ephemeral credentials copy, and a detached
   * in-place job's extracted tree. The install itself is never touched, so the
   * member keeps the release it is running.
   *
   * Once the activate step has started the services are being switched and a
   * kill could leave a half-restarted host; that state is refused and left to
   * the job's own rollback instead.
   * @param {string} id job id.
   * @returns {Promise<object|null>} settled job state (null when unknown).
   */
  async cancel(id) {
    if (typeof id !== "string" || !/^deploy-[A-Za-z0-9-]+$/u.test(id)) return null;
    const dir = path17.join(this.dataDir, id);
    const state = await readDeployState(dir);
    if (state === null) return null;
    if (state.status !== "running" && state.status !== "queued") return state;
    if (this.running.has(id)) {
      throw new Error("\u8FD9\u4E2A\u4EFB\u52A1\u5728\u5F53\u524D\u670D\u52A1\u8FDB\u7A0B\u5185\u8FD0\u884C\uFF0C\u65E0\u6CD5\u53D6\u6D88\uFF1B\u8BF7\u7B49\u5B83\u7ED3\u675F");
    }
    const activate = (state.steps ?? []).find((step) => step?.key === "activate");
    if (state.phase === "activate" || activate?.status === "running") {
      throw new Error("\u5347\u7EA7\u5DF2\u7ECF\u8FDB\u5165\u5207\u6362\u5E76\u91CD\u542F\u670D\u52A1\u7684\u9636\u6BB5\uFF0C\u4E0D\u80FD\u518D\u53D6\u6D88\uFF1B\u8BF7\u7B49\u5B83\u7ED3\u675F\uFF08\u5065\u5EB7\u68C0\u67E5\u5931\u8D25\u4F1A\u81EA\u52A8\u5207\u56DE\u4E0A\u4E00\u7248\uFF09");
    }
    const request = await readFile13(jobPaths(dir).request, "utf8").then(JSON.parse).catch(() => null);
    await appendDeployLog(dir, "cancel requested by user; stopping the runner");
    const stopped = await this.#stopRunner(id, dir);
    const after = await readDeployState(dir);
    if (after !== null && after.status !== "running" && after.status !== "queued") {
      await appendDeployLog(dir, `cancel ignored: the job already finished with ${after.status}`);
      return after;
    }
    const cleanup = await this.#cleanupCancelledJob(dir, request, after ?? state).catch((error) => ({ cleaned: [], failures: [error instanceof Error ? error.message : String(error)] }));
    const stamp = (/* @__PURE__ */ new Date()).toISOString();
    const cancelled = after ?? state;
    cancelled.status = "cancelled";
    cancelled.phase = "cancelled";
    for (const step of cancelled.steps ?? []) {
      if (step.status === "running") {
        step.status = "cancelled";
        step.finishedAt = stamp;
      }
    }
    cancelled.progress = { ...cancelled.progress ?? {}, label: "\u5DF2\u53D6\u6D88", percent: 0, indeterminate: false, speed: 0 };
    cancelled.error = cleanup.failures.length === 0 ? "\u5DF2\u53D6\u6D88\uFF1A\u5347\u7EA7\u8FDB\u7A0B\u5DF2\u505C\u6B62\uFF0C\u4E34\u65F6\u6587\u4EF6\u5DF2\u6E05\u7406\uFF0C\u6210\u5458\u4FDD\u6301\u5728\u539F\u7248\u672C" : `\u5DF2\u53D6\u6D88\uFF1A\u5347\u7EA7\u8FDB\u7A0B\u5DF2\u505C\u6B62\uFF1B\u6E05\u7406\u672A\u5B8C\u6210\uFF1A${cleanup.failures.join("\uFF1B")}\uFF08\u4E0B\u6B21\u5347\u7EA7\u4F1A\u81EA\u52A8\u8986\u76D6\uFF09`;
    cancelled.updatedAt = stamp;
    await writeDeployState(dir, cancelled);
    const stoppedText = stopped.length === 0 ? "\u5347\u7EA7\u8FDB\u7A0B\u5DF2\u4E0D\u5728\u8FD0\u884C" : `\u5DF2\u505C\u6B62 ${stopped.join("\u3001")}`;
    const cleanupText = cleanup.failures.length === 0 ? cleanup.cleaned.length === 0 ? "\u6CA1\u6709\u9700\u8981\u6E05\u7406\u7684\u4E34\u65F6\u6587\u4EF6" : `\u5DF2\u6E05\u7406 ${cleanup.cleaned.join("\u3001")}` : `\u6E05\u7406\u672A\u5B8C\u6210\uFF1A${cleanup.failures.join("\uFF1B")}`;
    await appendDeployLog(dir, `cancelled by user; ${stoppedText}; ${cleanupText}`);
    this.states.set(id, cancelled);
    this.logLine(`mesh deploy ${id} cancelled by user`);
    return cancelled;
  }
  /**
   * Stop the detached runner that owns one job.
   * @param {string} id job id.
   * @param {string} dir job directory.
   * @returns {Promise<string[]>} what was stopped.
   */
  async #stopRunner(id, dir) {
    const runner = await readFile13(path17.join(dir, "runner.json"), "utf8").then(JSON.parse).catch(() => null);
    const notes = [];
    const unit = typeof runner?.unit === "string" && runner.unit !== "" ? runner.unit : `dsh-mesh-job-${id.replace(/^deploy-/u, "")}`;
    if (await runCommandQuiet("systemctl", ["stop", unit], 3e4)) notes.push(unit);
    const pid = Number(runner?.pid);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      if (await terminateProcess(pid)) notes.push(`\u8FDB\u7A0B ${String(pid)}`);
    }
    return notes;
  }
  /**
   * Remove the temporary files one cancelled job created.
   * @param {string} dir job directory.
   * @param {object|null} request job request.
   * @param {object} state job state (for the creation time).
   * @returns {Promise<{cleaned: string[], failures: string[]}>} what was removed and what failed.
   */
  async #cleanupCancelledJob(dir, request, state) {
    const cleaned = [];
    const failures = [];
    const drop = async (target, label) => {
      try {
        await rm11(target, { recursive: true, force: true });
        cleaned.push(label);
      } catch (error) {
        failures.push(`${label}\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await drop(path17.join(dir, "stage"), "\u672C\u5730\u89E3\u538B\u76EE\u5F55");
    await drop(path17.join(dir, "tools"), "\u672C\u5730\u811A\u672C\u526F\u672C");
    if (request?.kind === "inplace") {
      const packagePath = String(request.inplace?.package ?? "");
      if (packagePath !== "") await rm11(`${packagePath}.part`, { force: true }).catch(() => {
      });
      const created = Date.parse(String(state.createdAt ?? ""));
      if (Number.isFinite(created)) {
        const entries = await readdir6(tmpdir3(), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.startsWith("dsh-mesh-download-")) continue;
          const full = path17.join(tmpdir3(), entry.name);
          const info = await stat10(full).catch(() => null);
          if (info !== null && info.mtimeMs >= created - 6e4) await drop(full, "\u4E0B\u8F7D\u4E34\u65F6\u76EE\u5F55");
        }
      }
      return { cleaned, failures };
    }
    const plan = request?.options?.plan;
    if (plan === null || plan === void 0 || typeof plan !== "object") return { cleaned, failures };
    const release = String(plan.release ?? "");
    if (plan.local === true) {
      if (/^[A-Za-z0-9._-]{3,80}$/u.test(release) && typeof plan.layoutRoot === "string" && plan.layoutRoot !== "") {
        await drop(path17.join(plan.layoutRoot, ".staging", release), "\u672C\u673A\u6682\u5B58\u76EE\u5F55");
      }
      if (plan.packageOnTarget !== true && typeof plan.remotePackage === "string" && path17.isAbsolute(plan.remotePackage) && plan.remotePackage.startsWith(tmpdir3() + path17.sep)) {
        await drop(plan.remotePackage, "\u672C\u673A\u4E34\u65F6\u5B89\u88C5\u5305");
      }
      return { cleaned, failures };
    }
    const cleanup = cancelCleanupScript(plan);
    if (cleanup === null) return { cleaned, failures };
    try {
      const runner = this.runnerFactory(plan);
      await runner.script(cleanup.script, cleanup.os);
      cleaned.push("\u6210\u5458\u4E0A\u7684\u6682\u5B58\u76EE\u5F55\u4E0E\u4E34\u65F6\u5B89\u88C5\u5305");
    } catch (error) {
      failures.push(`\u6210\u5458\u4E0A\u7684\u4E34\u65F6\u6587\u4EF6\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
    return { cleaned, failures };
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
      const stored = JSON.parse(await readFile13(path17.join(this.dataDir, id, "job.json"), "utf8"));
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
      entries = await readdir6(this.dataDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("deploy-")) continue;
      try {
        const stored = JSON.parse(await readFile13(path17.join(this.dataDir, entry.name, "job.json"), "utf8"));
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
      const text = await readFile13(path17.join(this.dataDir, id, "deploy.log"), "utf8");
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
    const dir = path17.join(this.dataDir, id);
    await mkdir10(dir, { recursive: true });
    const stateFile = path17.join(dir, "job.json");
    const logFile = path17.join(dir, "deploy.log");
    const state = {
      id,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: "rollback",
      status: "running",
      phase: "rollback",
      error: null
    };
    await writeFile9(stateFile, `${JSON.stringify(state, null, 2)}
`, "utf8");
    const log = async (line) => {
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      await writeFile9(logFile, `[${stamp}] ${line}
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

// src/lib/interop-client.mjs
import { existsSync as existsSync11, readFileSync as readFileSync3 } from "node:fs";
import path18 from "node:path";
var DEFAULT_INTEROP_PORT = 8765;
function readEnvFile(file) {
  const values = {};
  if (!existsSync11(file)) return values;
  for (const raw of readFileSync3(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}
function interopPortOf(service) {
  const configured = service?.config?.interopPort;
  if (Number.isSafeInteger(configured) && configured > 0 && configured < 65536) return configured;
  return DEFAULT_INTEROP_PORT;
}
function interopBaseUrl(address, port = DEFAULT_INTEROP_PORT) {
  const raw = String(address ?? "");
  if (/^https?:\/\//iu.test(raw)) return raw.replace(/\/+$/u, "");
  const host = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
  return `http://${host}:${String(port)}`;
}
function resolveInteropToken(service) {
  const configured = service?.config?.interopToken;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  if (process.env.DSH_INTEROP_TOKEN) return process.env.DSH_INTEROP_TOKEN;
  if (service?.config?.interopUseGatePassword !== false) {
    if (process.env.DSH_GATE_PASSWORD) return process.env.DSH_GATE_PASSWORD;
    const root = typeof service?.repositoryRoot === "string" ? service.repositoryRoot : "";
    const dataDir = typeof service?.dataDir === "string" ? service.dataDir : "";
    const candidates = [
      root === "" ? "" : path18.join(root, "..", "config", "gate.env"),
      root === "" ? "" : path18.join(root, "config", "gate.env"),
      dataDir === "" ? "" : path18.join(dataDir, "..", "..", "config", "gate.env")
    ].filter((candidate) => candidate !== "");
    for (const file of candidates) {
      const password = readEnvFile(file).DSH_GATE_PASSWORD;
      if (typeof password === "string" && password !== "") return password;
    }
  }
  throw new Error("no interop token: set interopToken, DSH_INTEROP_TOKEN, or DSH_GATE_PASSWORD");
}
async function memberInteropRequest(service, request) {
  const token = typeof request.token === "string" && request.token !== "" ? request.token : resolveInteropToken(service);
  const url = `${interopBaseUrl(request.address, interopPortOf(service))}${request.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 15e3);
  timer.unref?.();
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: request.method ?? "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...request.body === void 0 ? {} : { "content-type": "application/json" }
      },
      ...request.body === void 0 ? {} : { body: JSON.stringify(request.body) },
      signal: controller.signal
    });
    const text = await response.text();
    let data = null;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      data = null;
    }
    const code = data?.error?.code;
    const unsupported = response.status === 404 || response.status === 501 || code === "not_found" || code === "unknown_endpoint" || code === "unsupported";
    return { ok: response.ok && data?.ok !== false, status: response.status, unsupported, data, text };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

// src/lib/upgrade-announce.mjs
import { randomUUID } from "node:crypto";
import { mkdir as mkdir11, readFile as readFile14, rename as rename8, writeFile as writeFile10 } from "node:fs/promises";
import path19 from "node:path";

// src/lib/member-sessions.mjs
var memberSessions = /* @__PURE__ */ new Set();
function markMemberSession(sessionId) {
  const id = String(sessionId ?? "").trim();
  if (id !== "") memberSessions.add(id);
}
function unmarkMemberSession(sessionId) {
  memberSessions.delete(String(sessionId ?? "").trim());
}
function isMemberSession(sessionId) {
  return memberSessions.has(String(sessionId ?? "").trim());
}
function clearMemberSessions() {
  memberSessions.clear();
}

// src/lib/upgrade-announce.mjs
var UPGRADE_LEAD_MS = 10 * 6e4;
var UPGRADE_RESUME_DELAY_MS = 2 * 6e4;
var PLAN_REUSE_MS = UPGRADE_LEAD_MS * 4;
var UPGRADE_PLAN_MAX_AGE_MS = 30 * 6e4;
var UPGRADE_LEADER_MESSAGE = "\u8BF7\u901A\u8FC7call_member\u505C\u6B62\u6240\u6709\u8FDB\u884C\u4E2D\u7684\u6210\u5458\u5BF9\u8BDD\uFF0C\u628A\u9700\u8981\u63D0\u4EA4\u7684\u4EE3\u7801\u8FDB\u884C\u63D0\u4EA4\u3002\u5E76\u505C\u6B62\u6D3E\u53D1\u65B0\u7684\u4EFB\u52A1\u3002dsh\u51C6\u5907\u5347\u7EA7\uFF0C\u5C06\u4F1A\u91CD\u542F\u3002\u7B49\u6211\u901A\u77E5\u3002";
var UPGRADE_MEMBER_MESSAGE = "dsh\u51C6\u5907\u5347\u7EA7\uFF0C\u8BF7\u505C\u6B62\uFF0C\u628A\u9700\u8981\u63D0\u4EA4\u7684\u4EE3\u7801\u8FDB\u884C\u63D0\u4EA4\u3002";
var UPGRADE_PLAIN_MESSAGE = "dsh\u51C6\u5907\u5347\u7EA7\uFF0C\u8BF7\u505C\u6B62\u3002";
var UPGRADE_RESUME_MESSAGE = "\u91CD\u542F\u6210\u529F\uFF0C\u8BF7\u7EE7\u7EED\u3002";
var UPGRADE_KINDS = Object.freeze(["leader", "member", "plain"]);
function sessionCalledTool(agent, name) {
  const session = agent?.session;
  if (session === null || session === void 0) return false;
  let events;
  try {
    events = typeof session.ownEvents === "function" ? session.ownEvents() : session.snapshotEvents?.(0, session.seq);
  } catch {
    return false;
  }
  if (!Array.isArray(events)) return false;
  for (const event of events) {
    if (event?.type === "tool/call" && event?.data?.name === name) return true;
  }
  return false;
}
function classifyUpgradeConversation(agent) {
  const id = String(agent?.id ?? "");
  if (id === "") return "plain";
  if (isMemberSession(id)) return "member";
  return sessionCalledTool(agent, "call_member") ? "leader" : "plain";
}
function upgradeMessageFor(kind) {
  if (kind === "leader") return UPGRADE_LEADER_MESSAGE;
  if (kind === "member") return UPGRADE_MEMBER_MESSAGE;
  return UPGRADE_PLAIN_MESSAGE;
}
function userMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" }
  };
}
function injectUpgradeMessage(agent, text) {
  const message = userMessage(text);
  if (agent?.status === "running" && typeof agent.steer === "function") {
    try {
      agent.steer(message);
      return true;
    } catch {
    }
  }
  try {
    agent?.followup?.(message);
    return true;
  } catch {
    return false;
  }
}
async function readUpgradePlan(file) {
  try {
    const parsed = JSON.parse(await readFile14(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
async function writeUpgradePlan(file, plan) {
  await mkdir11(path19.dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile10(temporary, `${JSON.stringify(plan, null, 2)}
`, "utf8");
  await rename8(temporary, file);
}
function upgradePlanCounts(plan) {
  const counts = { leader: 0, member: 0, plain: 0 };
  for (const entry of Array.isArray(plan?.sessions) ? plan.sessions : []) {
    if (typeof entry?.kind === "string" && Object.hasOwn(counts, entry.kind)) counts[entry.kind] += 1;
  }
  return counts;
}
async function announceUpgrade(ctx, options) {
  const file = options.planFile;
  const log = typeof options.log === "function" ? options.log : () => {
  };
  const now = typeof options.now === "function" ? options.now : Date.now;
  const at = now();
  const existing = await readUpgradePlan(file);
  if (existing !== null && existing.resumedAt === null && typeof existing.announcedAt === "string") {
    const announcedAt = Date.parse(existing.announcedAt);
    if (Number.isFinite(announcedAt) && at - announcedAt < PLAN_REUSE_MS && announcedAt - at < PLAN_REUSE_MS) {
      log(`upgrade announcement reused (${existing.announcedAt})`);
      return {
        ok: true,
        already: true,
        announcedAt: existing.announcedAt,
        counts: upgradePlanCounts(existing)
      };
    }
  }
  const agents = typeof ctx?.get === "function" ? ctx.get("agents") : ctx?.agents;
  const list = typeof agents?.list === "function" ? agents.list() : [];
  const running = list.filter((agent) => agent?.status === "running");
  const counts = { leader: 0, member: 0, plain: 0 };
  const sessions = [];
  let announced = 0;
  for (const agent of running) {
    const kind = classifyUpgradeConversation(agent);
    const delivered = injectUpgradeMessage(agent, upgradeMessageFor(kind));
    if (!delivered) {
      log(`upgrade announcement could not reach ${String(agent?.id ?? "unknown")} (${kind})`);
      continue;
    }
    counts[kind] += 1;
    announced += 1;
    if (kind !== "member") sessions.push({ id: String(agent.id), kind });
  }
  const plan = {
    version: 1,
    announcedAt: new Date(at).toISOString(),
    counts,
    sessions,
    resumedAt: null
  };
  await writeUpgradePlan(file, plan);
  log(`upgrade announced to ${String(announced)} running conversation(s): leader ${String(counts.leader)}, member ${String(counts.member)}, plain ${String(counts.plain)}`);
  return { ok: true, already: false, announced, announcedAt: plan.announcedAt, counts };
}
async function resumeUpgradeConversations(ctx, options) {
  const file = options.planFile;
  const log = typeof options.log === "function" ? options.log : () => {
  };
  const now = typeof options.now === "function" ? options.now : Date.now;
  const plan = await readUpgradePlan(file);
  if (plan === null) return { ok: true, skipped: true, reason: "no plan" };
  if (typeof plan.resumedAt === "string" && plan.resumedAt !== "") {
    return { ok: true, skipped: true, reason: "already resumed" };
  }
  const sessions = Array.isArray(plan.sessions) ? plan.sessions : [];
  plan.resumedAt = new Date(now()).toISOString();
  await writeUpgradePlan(file, plan);
  const agents = typeof ctx?.get === "function" ? ctx.get("agents") : ctx?.agents;
  let resumed = 0;
  const failed = [];
  for (const entry of sessions) {
    const id = String(entry?.id ?? "");
    if (id === "") continue;
    try {
      let agent = typeof agents?.get === "function" ? agents.get(id) : void 0;
      if (agent === void 0 || agent === null) {
        if (typeof agents?.resume !== "function") {
          failed.push(id);
          continue;
        }
        const handle = await agents.resume({ resumeSessionId: id });
        agent = handle?.agent ?? null;
      }
      if (agent === null || agent === void 0) {
        failed.push(id);
        continue;
      }
      if (agent.status !== "idle") {
        log(`upgrade resume skipped ${id}: the conversation is ${String(agent.status)}`);
        continue;
      }
      if (injectUpgradeMessage(agent, UPGRADE_RESUME_MESSAGE)) resumed += 1;
      else failed.push(id);
    } catch (error) {
      failed.push(id);
      log(`upgrade resume failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`upgrade resume sent to ${String(resumed)} conversation(s)${failed.length === 0 ? "" : `; ${String(failed.length)} failed`}`);
  return { ok: true, skipped: false, resumed, failed, announcedAt: plan.announcedAt };
}
async function armUpgradeResume(ctx, options) {
  const log = typeof options.log === "function" ? options.log : () => {
  };
  const now = typeof options.now === "function" ? options.now : Date.now;
  const plan = await readUpgradePlan(options.planFile);
  if (plan === null) return false;
  if (typeof plan.resumedAt === "string" && plan.resumedAt !== "") return false;
  const announcedAt = Date.parse(String(plan.announcedAt ?? ""));
  if (Number.isFinite(announcedAt) && now() - announcedAt > UPGRADE_PLAN_MAX_AGE_MS) {
    plan.resumedAt = new Date(now()).toISOString();
    await writeUpgradePlan(options.planFile, plan);
    log(`upgrade plan from ${String(plan.announcedAt)} expired; no resume armed`);
    return false;
  }
  const delay2 = Number.isSafeInteger(options.delayMs) && options.delayMs >= 0 ? options.delayMs : UPGRADE_RESUME_DELAY_MS;
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const timer = setTimer(() => {
    void resumeUpgradeConversations(ctx, options).catch((error) => {
      const log2 = typeof options.log === "function" ? options.log : () => {
      };
      log2(`upgrade resume failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, delay2);
  timer?.unref?.();
  log(`upgrade resume armed in ${String(Math.round(delay2 / 1e3))}s for ${String(Array.isArray(plan.sessions) ? plan.sessions.length : 0)} conversation(s)`);
  return true;
}

// src/lib/scheduler.mjs
import { mkdir as mkdir12, readFile as readFile15, writeFile as writeFile11 } from "node:fs/promises";
import path22 from "node:path";

// src/lib/schedule.mjs
import path21 from "node:path";

// src/lib/build-artifacts.mjs
function memberBuildTarget(member) {
  const platform = String(member?.system?.platform ?? "").trim().toLowerCase();
  const arch = String(member?.system?.arch ?? "").trim().toLowerCase();
  if (arch !== "x64" && arch !== "arm64") return null;
  if (platform.startsWith("linux")) return `linux-${arch}`;
  if (platform.startsWith("win")) return `win-${arch}`;
  return null;
}
function pickArtifactForMember(artifacts, member) {
  const target = memberBuildTarget(member);
  if (target === null) return null;
  const list = Array.isArray(artifacts) ? artifacts : [];
  return list.find((artifact) => artifact !== null && typeof artifact === "object" && artifact.target === target) ?? null;
}

// src/lib/package-sources.mjs
import path20 from "node:path";
var PACKAGE_ARCHIVE_RE = /^dsh-mesh-(.+)-(\d{8}[A-Z]+)-(linux|win(?:dows)?)-(x64|arm64)\.(7z|tar\.gz|tgz|zip)$/u;
var DEPLOYABLE_ARCHIVE_RE = /^dsh-mesh-(?!plugin[-.])(.+)-(linux|win(?:dows)?)-(x64|arm64)\.(7z|tar\.gz|tgz|zip)$/u;
var RELEASE_TARGET_RE = /^(linux|win)-(x64|arm64)$/u;
function packagePlatformFromName(name) {
  const match = DEPLOYABLE_ARCHIVE_RE.exec(String(name ?? ""));
  if (match === null) return null;
  const os11 = match[2].startsWith("win") ? "windows" : "linux";
  const arch = match[3];
  return {
    version: match[1],
    os: os11,
    arch,
    target: `${os11 === "windows" ? "win" : "linux"}-${arch}`
  };
}
function packageTargetFromName(name) {
  const match = PACKAGE_ARCHIVE_RE.exec(String(name ?? ""));
  if (match === null) return null;
  const os11 = match[3].startsWith("win") ? "windows" : "linux";
  const arch = match[4];
  return {
    version: match[1],
    buildStamp: match[2],
    os: os11,
    arch,
    target: `${os11 === "windows" ? "win" : "linux"}-${arch}`
  };
}
function normalizeLatestManifest(manifest, options = {}) {
  const assets = [];
  const entries = manifest?.assets !== null && typeof manifest?.assets === "object" ? manifest.assets : {};
  for (const [target, entry] of Object.entries(entries)) {
    if (!RELEASE_TARGET_RE.test(target)) continue;
    if (entry === null || typeof entry !== "object") continue;
    const name = typeof entry.archive === "string" ? entry.archive.trim() : "";
    const parsed = packageTargetFromName(name);
    if (parsed === null || parsed.target !== target) continue;
    const bytes = Number(entry.bytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
    const sha256 = typeof entry.sha256 === "string" ? entry.sha256.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{64}$/u.test(sha256)) continue;
    const providers = [];
    if (typeof entry.github?.url === "string" && entry.github.url !== "") providers.push("github");
    if (Array.isArray(entry.gitee?.parts) && entry.gitee.parts.length > 0 && Array.isArray(entry.gitee?.urls) && entry.gitee.urls.length > 0) providers.push("gitee");
    assets.push({ target, os: parsed.os, arch: parsed.arch, name, bytes, sha256, providers });
  }
  assets.sort((left, right) => left.target.localeCompare(right.target));
  return {
    ok: assets.length > 0,
    configured: true,
    provider: typeof options.provider === "string" && options.provider !== "" ? options.provider : null,
    version: typeof manifest?.version === "string" ? manifest.version : null,
    buildStamp: typeof manifest?.buildStamp === "string" ? manifest.buildStamp : null,
    publishedAt: typeof manifest?.publishedAt === "string" ? manifest.publishedAt : null,
    assets,
    manifestUrls: Array.isArray(options.manifestUrls) ? options.manifestUrls.filter((url) => typeof url === "string") : [],
    ...assets.length === 0 ? { error: "\u53D1\u5E03\u6E05\u5355\u91CC\u6CA1\u6709\u53EF\u7528\u7684\u90E8\u7F72\u5305" } : {}
  };
}
function selectLatestAsset(release, target) {
  const wanted = normalizeTarget(target);
  if (wanted === "") return null;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => asset.target === wanted) ?? null;
}
function normalizeTarget(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const match = /^(linux|win(?:dows)?|win32)-(x64|arm64)$/u.exec(text);
  if (match === null) return "";
  return `${match[1].startsWith("linux") ? "linux" : "win"}-${match[2]}`;
}
function packageRoots(home, os11) {
  const base = String(home ?? "").replace(/[\\/]+$/u, "");
  if (base === "") return [];
  const join = os11 === "windows" ? path20.win32.join : path20.posix.join;
  return [join(base, ".dsh", "packages"), join(base, ".dsh", "mesh", "upgrade")];
}
function isAllowedPackagePath(candidate, home, os11) {
  const text = String(candidate ?? "").trim();
  if (text === "") return false;
  const p = os11 === "windows" ? path20.win32 : path20.posix;
  const normalized = p.normalize(text);
  if (packageTargetFromName(p.basename(normalized)) === null) return false;
  const roots = packageRoots(home, os11).map((root) => p.normalize(root));
  const comparand = os11 === "windows" ? normalized.toLowerCase() : normalized;
  return roots.some((root) => {
    const prefix = os11 === "windows" ? root.toLowerCase() : root;
    return comparand === prefix || comparand.startsWith(`${prefix}${p.sep}`);
  });
}
function parseTargetPackageList(stdout) {
  const packages = [];
  for (const line of String(stdout ?? "").split(/\r?\n/u)) {
    const text = line.trim();
    if (text === "") continue;
    const [file, rawBytes, rawMtime, rawSha] = text.split("	");
    if (file === void 0 || rawBytes === void 0) continue;
    const parsed = packageTargetFromName(file.split(/[\\/]/u).pop() ?? "");
    if (parsed === null) continue;
    const bytes = Number(rawBytes);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
    const sha256 = typeof rawSha === "string" && /^[a-f0-9]{64}$/u.test(rawSha.trim()) ? rawSha.trim().toLowerCase() : null;
    const mtime = normalizeMtime(rawMtime);
    packages.push({ name: file.split(/[\\/]/u).pop() ?? file, path: file, bytes, mtime, sha256, ...parsed });
  }
  packages.sort((left, right) => right.mtime.localeCompare(left.mtime));
  return packages;
}
function normalizeMtime(value) {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  if (/^\d+$/u.test(text)) {
    const seconds = Number.parseInt(text, 10);
    return Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1e3).toISOString() : "";
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}
function listPackagesScript(os11, home = "") {
  const homeDir = String(home ?? "").trim();
  if (os11 === "windows") {
    const base2 = homeDir === "" ? "$env:USERPROFILE" : powershellQuote(homeDir);
    return `$ErrorActionPreference = 'SilentlyContinue'
$base = ${base2}
$roots = @(
  (Join-Path $base '.dsh\\packages'),
  (Join-Path $base '.dsh\\mesh\\upgrade')
)
$rows = @()
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Name -match '^dsh-mesh-.*\\.(7z|zip|tar\\.gz|tgz)$' } | ForEach-Object {
    $sha = ''
    $side = "$($_.FullName).sha256"
    if (Test-Path -LiteralPath $side) {
      $first = Get-Content -LiteralPath $side -TotalCount 1
      if ($first) { $sha = ($first -split '\\s+')[0] }
    }
    $rows += ($_.FullName + [char]9 + $_.Length + [char]9 + $_.LastWriteTimeUtc.ToString('o') + [char]9 + $sha)
  }
}
$rows | ForEach-Object { Write-Output $_ }
`;
  }
  const base = homeDir === "" ? '"$HOME"' : shellQuote(homeDir);
  return `BASE=${base}
for root in "$BASE/.dsh/packages" "$BASE/.dsh/mesh/upgrade"; do
  [ -d "$root" ] || continue
  find "$root" -maxdepth 3 -type f \\( -name 'dsh-mesh-*.7z' -o -name 'dsh-mesh-*.tar.gz' -o -name 'dsh-mesh-*.tgz' -o -name 'dsh-mesh-*.zip' \\) -print0 2>/dev/null |
  while IFS= read -r -d '' file; do
    bytes=$(stat -c %s -- "$file" 2>/dev/null || echo 0)
    mtime=$(stat -c %Y -- "$file" 2>/dev/null || echo 0)
    sha=''
    side="$file.sha256"
    if [ -f "$side" ]; then sha=$(sed -n '1s/[[:space:]].*//p' "$side" 2>/dev/null || true); fi
    printf '%s\\t%s\\t%s\\t%s\\n' "$file" "$bytes" "$mtime" "$sha"
  done
done
`;
}
function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}
function powershellQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

// src/lib/schedule.mjs
var SCHEDULE_FORMAT = 3;
var DEFAULT_BUILD_SCHEDULE = Object.freeze({ enabled: false, time: "04:00" });
var DEFAULT_UPGRADE_SCHEDULE = Object.freeze({ enabled: false, time: "06:00" });
var LEGACY_BUILD_SCHEDULE = Object.freeze({ enabled: true, time: "04:00" });
var LEGACY_UPGRADE_SCHEDULE = Object.freeze({ enabled: true, time: "06:00" });
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
function migrateSchedules(value) {
  const schedule = normalizeSchedules(value);
  const format = value !== null && typeof value === "object" ? value.format : void 0;
  if (format === SCHEDULE_FORMAT) return schedule;
  if (schedule.build.enabled && schedule.build.time === LEGACY_BUILD_SCHEDULE.time) {
    schedule.build = { ...schedule.build, enabled: false };
  }
  if (schedule.upgrade.enabled && schedule.upgrade.time === LEGACY_UPGRADE_SCHEDULE.time) {
    schedule.upgrade = { ...schedule.upgrade, enabled: false };
  }
  return schedule;
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
  const match = /^dsh-mesh-(.+)-(\d{8}[A-Z]+)-(linux|win(?:dows)?)-(?:x64|arm64)\.(?:7z|tar\.gz|tgz|zip)$/u.exec(name);
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
    if (parsed === null) continue;
    const current = latest[parsed.os];
    if (current === void 0) {
      latest[parsed.os] = item;
      continue;
    }
    const currentInfo = packageInfo(current.name);
    if (currentInfo !== null && compareBuildStamps(parsed.buildStamp, currentInfo.buildStamp) > 0) {
      latest[parsed.os] = item;
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
  if (parsed === null) return { needed: false, reason: "\u4E0D\u662F\u53EF\u8BC6\u522B\u7684\u90E8\u7F72\u5305\uFF0C\u8DF3\u8FC7" };
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
function planMemberUpgrade(member, packages, release) {
  const deployment = memberDeployment(member);
  if (deployment === null) return { reason: "\u8BFB\u4E0D\u5230\u5F53\u524D\u90E8\u7F72" };
  if (member?.online === false) return { reason: "\u79BB\u7EBF" };
  const os11 = memberOs(member);
  const local = latestPackagesByOs(packages)[os11] ?? null;
  const target = memberBuildTarget(member);
  const asset = release !== null && release?.ok === true && target !== null ? selectLatestAsset(release, target) : null;
  let chosen = local === null ? null : { source: "local", package: local, target: null };
  if (asset !== null) {
    const candidate = { source: "release", package: asset, target: asset.target };
    if (chosen === null || newerPackage(candidate.package, chosen.package)) chosen = candidate;
  }
  if (chosen === null) return { reason: `\u6CA1\u6709 ${os11 === "windows" ? "Windows" : "Linux"} \u90E8\u7F72\u5305` };
  const decision = shouldUpgrade(deployment, chosen.package);
  if (!decision.needed) return { reason: decision.reason };
  return { ...chosen, reason: decision.reason };
}
function newerPackage(candidate, current) {
  const next = packageInfo(candidate?.name);
  const previous = packageInfo(current?.name);
  if (next === null || previous === null) return false;
  return compareBuildStamps(next.buildStamp, previous.buildStamp) > 0;
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
  return path21.join(dataDir, "schedule.json");
}

// src/lib/scheduler.mjs
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
    this.last = { build: null, upgrades: {}, prepares: {} };
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
      // The announcement runs one lead time before the upgrade itself, so the
      // panel can show that the member's conversations were told to stop.
      ...kind === "build" ? {} : { prepare: this.last.prepares?.[memberId] ?? null },
      running: kind === "build" ? this.runningBuild : this.runningUpgrades.has(memberId),
      ...memberId === void 0 ? {} : { member: memberId }
    };
  }
  /** Read the schedule file once. */
  async #load() {
    if (this.loading !== null) return this.loading;
    this.loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile15(this.file, "utf8"));
        const normalized = migrateSchedules(parsed);
        this.schedule = normalized;
        this.upgrades = new Map(Object.entries(normalized.upgrades));
        if (parsed?.last !== null && typeof parsed?.last === "object") {
          this.last = {
            build: typeof parsed.last.build === "object" ? parsed.last.build : null,
            upgrades: parsed.last.upgrades !== null && typeof parsed.last.upgrades === "object" ? parsed.last.upgrades : {},
            prepares: parsed.last.prepares !== null && typeof parsed.last.prepares === "object" ? parsed.last.prepares : {}
          };
        }
        if (parsed?.format !== SCHEDULE_FORMAT) await this.#save();
      } catch {
      }
    })();
    return this.loading;
  }
  /** Persist the current settings and last outcomes. */
  async #save() {
    try {
      await mkdir12(path22.dirname(this.file), { recursive: true });
      await writeFile11(this.file, `${JSON.stringify({
        format: SCHEDULE_FORMAT,
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
      const upgradeAt = nextRunAt(at, entry.time);
      candidates.push({ kind: "upgrade", memberId, at: upgradeAt });
      const prepareAt = new Date(upgradeAt.getTime() - UPGRADE_LEAD_MS);
      if (prepareAt.getTime() > at.getTime() + 1e3) {
        candidates.push({ kind: "prepare", memberId, at: prepareAt });
      }
    }
    if (candidates.length === 0) return;
    candidates.sort((left, right) => left.at.getTime() - right.at.getTime());
    const next = candidates[0];
    const delay2 = Math.max(0, next.at.getTime() - at.getTime());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.#tick();
    }, delay2);
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
        if (!entry.enabled) continue;
        const prepareDue = [new Date(at.getTime() - 24 * 60 * 6e4), at].some((reference) => {
          const upgradeAt = nextRunAt(reference, entry.time);
          return this.#isDueTime(new Date(upgradeAt.getTime() - UPGRADE_LEAD_MS), at);
        });
        if (prepareDue && !this.#recentlyRan(this.last.prepares?.[memberId])) {
          await this.#runPrepare(memberId);
        }
        if (!this.#isDue(entry.time, at)) continue;
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
  /** Whether one exact instant is within the tick window. */
  #isDueTime(due, at) {
    return Math.abs(due.getTime() - at.getTime()) <= TICK_TOLERANCE_MS;
  }
  /** Whether this kind already ran within the duplicate window. */
  #recentlyRan(last) {
    const at = last?.at;
    return typeof at === "string" && Math.abs(this.now() - Date.parse(at)) < DUPLICATE_WINDOW_MS;
  }
  /**
   * Run the pre-upgrade announcement and record the outcome.
   *
   * Independent of the upgrade tick on purpose: a failure only means the
   * conversations were not stopped in time, and the upgrade still runs.
   * @param {string} memberId member id.
   * @returns {Promise<void>} when recorded.
   */
  async #runPrepare(memberId) {
    const at = new Date(this.now()).toISOString();
    try {
      this.log(`prepare ${memberId} tick at ${at}`);
      const result = await this.service.scheduledPrepareUpgrade(memberId);
      this.last.prepares ??= {};
      this.last.prepares[memberId] = { at, ...result !== null && typeof result === "object" ? result : { status: "unknown" } };
      await this.#save();
      this.log(`prepare ${memberId}: ${String(this.last.prepares[memberId].status ?? "unknown")}${this.last.prepares[memberId].reason ? ` (${String(this.last.prepares[memberId].reason)})` : ""}`);
    } catch (error) {
      this.last.prepares ??= {};
      this.last.prepares[memberId] = { at, status: "failed", reason: error instanceof Error ? error.message : String(error) };
      await this.#save();
      this.log(`prepare ${memberId} failed: ${String(this.last.prepares[memberId].reason)}`);
    }
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
async function readScheduleFile(file) {
  try {
    const parsed = JSON.parse(await readFile15(file, "utf8"));
    const schedule = migrateSchedules(parsed);
    return {
      schedule,
      upgrades: schedule.upgrades,
      last: {
        build: typeof parsed?.last?.build === "object" ? parsed.last.build : null,
        upgrades: parsed?.last?.upgrades !== null && typeof parsed?.last?.upgrades === "object" ? parsed.last.upgrades : {},
        prepares: parsed?.last?.prepares !== null && typeof parsed?.last?.prepares === "object" ? parsed.last.prepares : {}
      }
    };
  } catch {
    return {
      schedule: normalizeSchedules({}),
      upgrades: {},
      last: { build: null, upgrades: {}, prepares: {} }
    };
  }
}

// src/lib/remote-build.mjs
import { createHash as createHash5 } from "node:crypto";
import { mkdtemp as mkdtemp6, open as open4, rename as rename9, rm as rm12, stat as stat11, writeFile as writeFile12 } from "node:fs/promises";
import { tmpdir as tmpdir4 } from "node:os";
import path23 from "node:path";
var DEFAULT_MESH_REPO = "https://github.com/Cangjier/dsh-mesh.git";
var REMOTE_SRC = "$HOME/.dsh/mesh/build-src";
var REMOTE_JOBS = "$HOME/.dsh/mesh/build";
var REMOTE_STAGE = "$HOME/.dsh/mesh/upgrade";
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
    // Archives staged for a previous build's automatic upgrade are one copy
    // per build; the upgrade has long finished by the time another build runs.
    `find "${REMOTE_STAGE}" -mindepth 1 -maxdepth 1 -type d ! -name ${quote(String(options.jobId))} -exec rm -rf {} + 2>/dev/null || true`,
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
    `"${REMOTE_NODE_DIR}/node" code/build/cli.mjs build --stream --out "${out}" --ref ${quote(ref)} --targets ${quote(targets)}${options.buildStamp ? ` --build-stamp ${quote(options.buildStamp)}` : ""}${options.proxyUrl ? ` --proxy ${quote(options.proxyUrl)}` : ""}${options.full === false ? " --web-only" : ""}${publishArgument(options)}`,
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
  const candidates = windowsNodeLookup(appRoot);
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
    `foreach ($candidate in @(${candidates})) { if (Test-Path (Join-Path $candidate 'node.exe')) { $nodeDir = $candidate; break } }`,
    "if ($null -eq $nodeDir) { throw 'no node runtime on this member' }",
    // Last run's job tree is removed by a background Node process instead of
    // synchronously: a 1.9 GiB / 112k-file tree took minutes on the Windows
    // member, and that was pure delay in front of every build. Remove-Item is
    // not an option — node_modules paths are longer than MAX_PATH and it gives
    // up halfway through, which is exactly how a member's disk filled up.
    "$buildRoot = Join-Path $root 'build'",
    "$upgradeRoot = Join-Path $root 'upgrade'",
    ...rmTreeScriptLines(),
    `$leftovers = @(Get-ChildItem -LiteralPath $buildRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne ${quotePs(String(options.jobId))} }) + @(Get-ChildItem -LiteralPath $upgradeRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne ${quotePs(String(options.jobId))} })`,
    "$cleaners = @()",
    `foreach ($dir in $leftovers) { try { $cleaners += Start-Process -FilePath (Join-Path $nodeDir 'node.exe') -ArgumentList ('"{0}" "{1}"' -f (Join-Path $bin 'rm-tree.cjs'), $dir.FullName) -WindowStyle Hidden -PassThru -ErrorAction Stop } catch { Write-Output ('could not start the leftover cleanup: ' + $dir.Name) } }`,
    "$driveFree = 0",
    "try { $driveFree = (Get-PSDrive ((Get-Item $env:USERPROFILE).PSDrive.Name)).Free } catch { $driveFree = (Get-PSDrive C).Free }",
    `if ($driveFree -lt ${String(needGiB * 1024 ** 3)}) {`,
    // Only the rare full-disk start waits for the deletion; a normal build
    // downloads its checkout while the previous tree is still going away.
    "  foreach ($cleaner in $cleaners) { if (-not $cleaner.HasExited) { $cleaner.WaitForExit(600000) | Out-Null } }",
    "  try { $driveFree = (Get-PSDrive ((Get-Item $env:USERPROFILE).PSDrive.Name)).Free } catch { $driveFree = (Get-PSDrive C).Free }",
    `  if ($driveFree -lt ${String(needGiB * 1024 ** 3)}) { throw ("not enough free space on the build host: {0:N1} GiB free, ${String(needGiB)} GiB needed" -f ($driveFree / 1GB)) }`,
    "}",
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
    `& (Join-Path $nodeDir 'node.exe') code/build/cli.mjs build --stream --out $out --ref ${quotePs(options.ref)} --targets ${quotePs(options.targets.join(","))}${options.buildStamp ? ` --build-stamp ${quotePs(options.buildStamp)}` : ""}${proxy2 === "" ? "" : ` --proxy ${quotePs(proxy2)}`}${options.full === false ? " --web-only" : ""}${windowsPublishArgument(options)}`,
    "$code = $LASTEXITCODE",
    "Get-ChildItem -Directory $out -ErrorAction SilentlyContinue | Select-Object -First 5 -ExpandProperty FullName",
    "exit $code",
    ""
  ].filter((line) => line !== "").join("\r\n");
}
var RM_TREE_SCRIPT = [
  "const fs = require('fs')",
  "const target = process.argv[2]",
  "try {",
  "  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })",
  "} catch (error) {",
  "  console.error(String(error && error.message ? error.message : error))",
  "  process.exitCode = 1",
  "}"
].join("\n");
function rmTreeScriptLines() {
  return [
    "$rmScript = @'",
    ...RM_TREE_SCRIPT.split("\n"),
    "'@",
    "[IO.File]::WriteAllText((Join-Path $bin 'rm-tree.cjs'), $rmScript, (New-Object System.Text.UTF8Encoding($false)))"
  ];
}
function windowsNodeLookup(appRoot) {
  const root = String(appRoot ?? "").replace(/[\\/]+$/u, "");
  return [
    ...root === "" ? [] : [quotePs(`${root}\\runtime\\node`)],
    '"$env:USERPROFILE\\.dsh\\runtime\\node"',
    '"$env:USERPROFILE\\.dsh\\dsh-mesh\\current\\runtime\\node"',
    '"$env:USERPROFILE\\.dsh\\dsh-person-web\\runtime\\node"',
    '"$env:ProgramFiles\\nodejs"'
  ].join(", ");
}
function windowsCleanupScript(options) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$root = Join-Path $env:USERPROFILE '.dsh\\mesh'",
    "$bin = Join-Path $root 'bin'",
    "$out = Join-Path $root 'build\\" + String(options.jobId) + "'",
    "New-Item -ItemType Directory -Force -Path $bin | Out-Null",
    "$nodeDir = $null",
    `foreach ($candidate in @(${windowsNodeLookup(options.appRoot ?? "")})) { if (Test-Path (Join-Path $candidate 'node.exe')) { $nodeDir = $candidate; break } }`,
    ...rmTreeScriptLines(),
    'if (-not (Test-Path -LiteralPath $out)) { Write-Output ("DSH-MESH-MISSING=" + $out); exit 0 }',
    "if ($null -ne $nodeDir) { & (Join-Path $nodeDir 'node.exe') (Join-Path $bin 'rm-tree.cjs') $out 2>$null | Out-Null }",
    "if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force -ErrorAction SilentlyContinue }",
    "if (Test-Path -LiteralPath $out) {",
    "  $left = (Get-ChildItem -LiteralPath $out -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count",
    '  Write-Output ("DSH-MESH-LEFTOVER=" + $out + " files=" + $left)',
    '} else { Write-Output ("DSH-MESH-REMOVED=" + $out) }',
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
  const encoded = runs.reduce((best, run3) => run3.length > best.length ? run3 : best, "");
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
  const hash = createHash5("sha256");
  const handle = await open4(file, "r");
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
   * @param {{plan: {os?: string, appRoot?: string}, memberName: string, proxyUrl?: string|null, repoUrl?: string, buildStamp?: string, heapMb?: number, releaseConfig?: object|null, pullBack?: boolean, stageTarget?: string|null, full?: boolean}} options run options.
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
      publish: releaseConfigRemote !== null,
      full: options.full
    }) : remoteBuildScript({
      jobId: state.id,
      ref: state.ref,
      targets: state.targets,
      proxyUrl: options.proxyUrl,
      repoUrl: options.repoUrl,
      buildStamp: options.buildStamp,
      heapMb: options.heapMb,
      releaseConfigRemote,
      publish: releaseConfigRemote !== null,
      full: options.full
    });
    let percent = 1;
    let currentTarget = typeof state.currentTarget === "string" ? state.currentTarget : null;
    const onLine = (line) => {
      void appendLog(jobDir, line);
      const update = phaseFromLine(line, state.targets, { currentTarget });
      if (update === null) return;
      const patch = { phase: update.phase };
      if (typeof update.percent === "number" && update.percent > percent) {
        percent = update.percent;
        patch.percent = percent;
      }
      if (update.currentTarget !== void 0) {
        currentTarget = update.currentTarget;
        patch.currentTarget = update.currentTarget;
      }
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
    const pullBack = options.pullBack === true;
    const stageTarget = typeof options.stageTarget === "string" && options.stageTarget !== "" ? options.stageTarget : null;
    if (!pullBack && directories.length > 0) {
      await appendLog(jobDir, "pull-back is off; the archives stay on the build host");
    }
    let pulled = 0;
    if (pullBack && directories.length > 0) await this.#update(jobDir, { phase: "fetch", percent: 96, currentTarget: null });
    const pullOne = async (remoteArchive) => {
      const local = await this.#pull(runner, remoteArchive, windows);
      const info = await stat11(local);
      const digest = await sha256File3(local);
      await writeSidecar(local, digest);
      await appendLog(jobDir, `pulled ${path23.basename(local)} (${String(info.size)} bytes)`);
      pulled += 1;
      await this.#update(jobDir, { phase: "fetch", percent: 96 + Math.round(3 * pulled / directories.length) });
      return { local, digest, bytes: info.size };
    };
    let preservedAll = true;
    if (!pullBack && directories.length > 0 && stageTarget === null) {
      preservedAll = false;
      await appendLog(jobDir, "pull-back is off and no upgrade target is staged; keeping the member build dir so the archives survive");
    }
    for (const artifact of directories) {
      const remoteArchive = typeof artifact.archive === "string" ? artifact.archive : "";
      if (remoteArchive === "") continue;
      let local = null;
      let digest = typeof artifact.sha256 === "string" && artifact.sha256 !== "" ? artifact.sha256 : null;
      let bytes = Number.isSafeInteger(artifact.bytes) ? artifact.bytes : null;
      if (pullBack) {
        const pulledArtifact = await pullOne(remoteArchive);
        local = pulledArtifact.local;
        digest = pulledArtifact.digest;
        bytes = pulledArtifact.bytes;
      }
      let staged = null;
      if (stageTarget !== null && artifact.target === stageTarget) {
        staged = await this.#stageArtifact(runner, jobDir, state.id, remoteArchive, windows);
        if (staged !== null) {
          if (digest === null) digest = staged.sha256;
          if (bytes === null) bytes = staged.bytes;
          await appendLog(jobDir, `staged ${path23.basename(staged.path)} for the automatic upgrade (${String(staged.bytes)} bytes)`);
        } else if (local === null) {
          await appendLog(jobDir, "staging failed; pulling the archive back so the build result is preserved");
          try {
            const pulledArtifact = await pullOne(remoteArchive);
            local = pulledArtifact.local;
            digest = pulledArtifact.digest;
            bytes = pulledArtifact.bytes;
          } catch (error) {
            preservedAll = false;
            await appendLog(jobDir, `could not preserve the archive: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      artifacts.push({
        target: artifact.target,
        archive: local ?? staged?.path ?? remoteArchive,
        remoteArchive,
        stagedArchive: staged?.path ?? null,
        pulled: local !== null,
        bytes,
        sha256: digest,
        manifest: artifact.manifest ?? null,
        smoke: artifact.smoke ?? null
      });
    }
    if (!pullBack && directories.length > 0 && stageTarget !== null && !artifacts.some((artifact) => artifact.stagedArchive !== null || artifact.pulled)) {
      preservedAll = false;
      await appendLog(jobDir, `pull-back is off and ${stageTarget} was not packaged; keeping the member build dir so the archives survive`);
    }
    const done = await this.#update(jobDir, {
      status: "done",
      phase: "done",
      percent: 100,
      currentTarget: null,
      artifacts,
      pulledBack: pullBack || artifacts.some((artifact) => artifact.pulled),
      remoteDirKept: !preservedAll,
      remoteJob: remote.id ?? null,
      version: remote.version ?? null,
      publish: remote.publish ?? null
    });
    await this.#cleanupReleaseConfig(runner, releaseConfigRemote, windows);
    if (preservedAll) {
      await this.#cleanupRemote(runner, jobDir, state.id, windows);
    } else {
      await appendLog(jobDir, `member build dir kept for recovery: $HOME/.dsh/mesh/build/${state.id}`);
    }
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
    const dir = await mkdtemp6(path23.join(tmpdir4(), "dsh-mesh-release-config-"));
    const local = path23.join(dir, "release.json");
    await writeFile12(local, `${JSON.stringify(config, null, 2)}
`, { encoding: "utf8", mode: 384 });
    try {
      if (windows) {
        const dir2 = path23.win32.dirname(remote);
        await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), `cmd /c if not exist "${dir2}" mkdir "${dir2}"`]);
      } else {
        await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), `umask 077; : > '${remote.replace(/'/gu, `'\\''`)}'`]);
      }
      await runner.upload(local, remote);
      if (!windows) {
        await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), `chmod 600 '${remote.replace(/'/gu, `'\\''`)}'`]);
      }
    } finally {
      await rm12(dir, { recursive: true, force: true }).catch(() => {
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
   * older jobs filled. Windows deletes through the shared `rm-tree.cjs` helper
   * (node's fs.rmSync) because node_modules paths are longer than MAX_PATH and
   * Remove-Item gives up on them halfway; the outcome is reported as it really
   * is, so a half-deleted tree is not logged as "removed".
   * @param {SshRunner} runner ssh runner.
   * @param {string} jobDir local job directory (the cleanup is logged there).
   * @param {string} jobId build job id (also the remote directory name).
   * @param {boolean} windows whether the member runs Windows.
   * @returns {Promise<void>} completion.
   */
  async #cleanupRemote(runner, jobDir, jobId, windows) {
    const localPath = `$HOME/.dsh/mesh/build/${jobId}`;
    const command = windows ? powershellCommand(windowsCleanupScript({ jobId, appRoot: runner.plan.appRoot })) : `rm -rf "${localPath}"`;
    try {
      const { stdout } = await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), command]);
      const text = String(stdout);
      const leftover = /^DSH-MESH-LEFTOVER=(.+)$/mu.exec(text)?.[1]?.trim() ?? "";
      if (leftover !== "") {
        await appendLog(jobDir, `member build dir partially removed: ${leftover} (the next build retries)`);
        this.log(`remote build dir partially removed: ${leftover}`);
        return;
      }
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
    const name = remote.split(/[\\/]/u).pop() ?? path23.basename(remote);
    const local = path23.join(this.packagesDir, name);
    const temporary = `${local}.part`;
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-P", String(runner.plan.port ?? 22)];
    if (runner.plan.identityFile) args.push("-i", runner.plan.identityFile);
    args.push(`${runner.target()}:${windows ? remote.replace(/\\/gu, "/") : remote}`, temporary);
    await runner.runProcess("scp", args);
    await rm12(local, { force: true });
    await rename9(temporary, local);
    return local;
  }
  /**
   * Move one finished archive to a stable directory on the build host.
   *
   * The automatic upgrade starts after the temporary job tree is deleted, so
   * the archive has to outlive it. It is copied (the original stays for a
   * pull-back fallback) and its digest is computed on the build host: the
   * upgrade plan needs bytes and SHA-256, and pulling 300–420 MiB back to the
   * gateway just to hash it would defeat the point of leaving the package
   * there.
   * @param {SshRunner} runner ssh runner.
   * @param {string} jobDir local job directory (used for logging).
   * @param {string} jobId build job id.
   * @param {string} remoteArchive archive path on the build host.
   * @param {boolean} windows whether the build host runs Windows.
   * @returns {Promise<{path: string, bytes: number, sha256: string}|null>} staged archive, or null.
   */
  async #stageArtifact(runner, jobDir, jobId, remoteArchive, windows) {
    const name = remoteArchive.split(/[\\/]/u).pop() ?? path23.basename(remoteArchive);
    const command = windows ? powershellCommand([
      "$ProgressPreference = 'SilentlyContinue'",
      `$stage = Join-Path $env:USERPROFILE '.dsh\\mesh\\upgrade\\${jobId}'`,
      "New-Item -ItemType Directory -Force -Path $stage | Out-Null",
      `$dest = Join-Path $stage ${quotePs(name)}`,
      `Copy-Item -LiteralPath ${quotePs(remoteArchive)} -Destination $dest -Force`,
      'Write-Output ("DSH-MESH-STAGED=" + $dest)',
      'Write-Output ("DSH-MESH-SHA256=" + (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower())',
      'Write-Output ("DSH-MESH-BYTES=" + (Get-Item -LiteralPath $dest).Length)'
    ].join("; ")) : [
      "set -e",
      `stage="${REMOTE_STAGE}/${jobId}"`,
      'mkdir -p "$stage"',
      `dest="$stage/${name}"`,
      `cp -f -- ${quote(remoteArchive)} "$dest"`,
      `printf 'DSH-MESH-STAGED=%s\\n' "$dest"`,
      `printf 'DSH-MESH-SHA256=%s\\n' "$(sha256sum -- "$dest" | awk '{print $1}')"`,
      `printf 'DSH-MESH-BYTES=%s\\n' "$(stat -c %s -- "$dest")"`
    ].join("\n");
    try {
      const { stdout } = await runner.runProcess("ssh", [...runner.sshOptions(), runner.target(), command]);
      const text = String(stdout);
      const staged = /^DSH-MESH-STAGED=(.+)$/mu.exec(text)?.[1].trim() ?? "";
      const sha256 = /^DSH-MESH-SHA256=([a-f0-9]{64})$/mu.exec(text)?.[1] ?? "";
      const bytes = Number.parseInt(/^DSH-MESH-BYTES=(\d+)$/mu.exec(text)?.[1] ?? "", 10);
      if (staged === "" || sha256 === "" || !Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new Error(`the build host did not report a staged archive (${text.trim().slice(-200)})`);
      }
      return { path: staged, bytes, sha256 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog(jobDir, `could not stage an archive for the automatic upgrade: ${message}`);
      return null;
    }
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
  await writeFile12(`${file}.sha256`, `${digest}  ${path23.basename(file)}
`, "utf8");
}

// code/shared/cluster.mjs
import { createHash as createHash6, createHmac, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
function deriveClusterSecret(password) {
  if (typeof password !== "string" || password === "") return "";
  return createHash6("sha256").update("dsh-mesh/cluster/v1\0").update(password, "utf8").digest("hex");
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
function payloadOf(method, path33, timestamp, nonce) {
  return [VERSION, String(method).toUpperCase(), path33, String(timestamp), nonce].join("\n");
}

// code/build/repack.mjs
import { execFile } from "node:child_process";
import { createHash as createHash7 } from "node:crypto";
import { cp as cp3, mkdir as mkdir13, mkdtemp as mkdtemp7, readFile as readFile16, readdir as readdir7, rm as rm13, stat as stat12, writeFile as writeFile13 } from "node:fs/promises";
import { createReadStream as createReadStream6, existsSync as existsSync12 } from "node:fs";
import path24 from "node:path";
import { promisify } from "node:util";
var run2 = promisify(execFile);
var CODE_SCRIPTS = ["install.sh", "install.ps1"];
var ROOT_SCRIPTS = ["start-interop.sh", "install-interop-service.sh", "uninstall-interop-service.sh", "dsh-mesh.mjs"];
var PLUGIN_FILES = ["index.js", "client.js", "cordis.patch.yml", "package.json"];
var PLUGIN_DIRS = ["locale", "build", "code/build", "code/shared", "code/deploy", "code/install", "code/gate/assets/7z"];
var CODE_DIRS = ["windows-service", "interop-service", "wireguard", "dsh-service", "deploy", "install", "shared"];
async function clear(target) {
  await rm13(target, { recursive: true, force: true });
}
async function replaceDirectory(from, to) {
  if (!existsSync12(from)) return;
  await clear(to);
  await cp3(from, to, { recursive: true });
}
async function replaceFile(from, to) {
  if (!existsSync12(from)) return;
  await clear(to);
  await cp3(from, to);
}
async function countFiles(dir) {
  let total = 0;
  for (const entry of await readdir7(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(path24.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}
async function repackDirectory(packageDir, repositoryRoot) {
  const manifestFile = path24.join(packageDir, "manifest.json");
  if (!existsSync12(manifestFile)) throw new Error(`${packageDir} is not an extracted package (no manifest.json)`);
  await replaceDirectory(path24.join(repositoryRoot, "code", "gate"), path24.join(packageDir, "gate"));
  await replaceDirectory(path24.join(repositoryRoot, "code", "shared"), path24.join(packageDir, "shared"));
  await replaceDirectory(path24.join(repositoryRoot, "code", "config"), path24.join(packageDir, "config"));
  for (const name of CODE_DIRS) {
    await replaceDirectory(path24.join(repositoryRoot, "code", name), path24.join(packageDir, "code", name));
  }
  await replaceDirectory(path24.join(repositoryRoot, "docs"), path24.join(packageDir, "docs"));
  for (const name of CODE_SCRIPTS) {
    await replaceFile(path24.join(repositoryRoot, "code", name), path24.join(packageDir, name));
  }
  for (const name of ROOT_SCRIPTS) {
    await replaceFile(path24.join(repositoryRoot, name), path24.join(packageDir, name));
  }
  for (const name of PLUGIN_FILES) {
    await replaceFile(path24.join(repositoryRoot, name), path24.join(packageDir, "plugins", "dsh-mesh", name));
  }
  for (const name of PLUGIN_DIRS) {
    await replaceDirectory(path24.join(repositoryRoot, name), path24.join(packageDir, "plugins", "dsh-mesh", name));
  }
  const manifest = JSON.parse(await readFile16(manifestFile, "utf8"));
  const features = new Set(Array.isArray(manifest.features) ? manifest.features : []);
  features.add("embedded-interop");
  manifest.features = [...features];
  const staticAssets = await collectStaticAssets(path24.join(packageDir, "gate"));
  manifest.staticAssets = staticAssets;
  manifest.builtAt = (/* @__PURE__ */ new Date()).toISOString();
  manifest.repackedFrom = "code/build/repack.mjs";
  manifest.files = await countFiles(packageDir);
  await writeFile13(manifestFile, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
  const clientBytes = (await stat12(path24.join(packageDir, "plugins", "dsh-mesh", "client.js"))).size;
  return { packageDir, version: manifest.version, target: manifest.target, files: manifest.files, clientBytes };
}
async function sha256File4(file) {
  const hash = createHash7("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream6(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}
function archiveRootName(file) {
  return path24.basename(file).replace(/\.(7z|tar\.gz|tgz|zip)$/u, "");
}
async function extractArchive(file, directory, repositoryRoot) {
  await mkdir13(directory, { recursive: true });
  if (isSevenZipArchive(file)) {
    const binary = await ensureSevenZipBinary(hostSevenZipPath(repositoryRoot));
    await run2(binary, ["x", "-y", "-bd", `-o${directory}`, file]);
  } else if (file.endsWith(".zip")) {
    try {
      await run2("unzip", ["-q", file, "-d", directory]);
    } catch {
      await run2("tar", ["-xf", file, "-C", directory]);
    }
  } else {
    await run2("tar", ["-xzf", file, "-C", directory]);
  }
  const root = path24.join(directory, archiveRootName(file));
  if (!existsSync12(path24.join(root, "manifest.json"))) {
    throw new Error(`archive ${path24.basename(file)} has no ${archiveRootName(file)}/manifest.json`);
  }
  return root;
}
async function compressDirectory(parent, name, file, repositoryRoot) {
  await clear(file);
  if (isSevenZipArchive(file)) {
    const binary = await ensureSevenZipBinary(hostSevenZipPath(repositoryRoot));
    await run2(binary, ["a", "-t7z", "-mx=5", "-mmt=on", "-bd", "-snl", file, name], { cwd: parent });
  } else if (file.endsWith(".zip")) {
    try {
      await run2("zip", ["-qr", "-X", file, name], { cwd: parent });
    } catch {
      await run2("tar", ["-a", "-cf", file, name], { cwd: parent });
    }
  } else {
    await run2("tar", ["-czf", file, name], { cwd: parent });
  }
}
async function repackArchive(file, { repositoryRoot, log = () => {
} }) {
  const work = await mkdtemp7(path24.join(path24.dirname(file), ".repack-"));
  try {
    log(`extracting ${path24.basename(file)}`);
    const packageDir = await extractArchive(file, work, repositoryRoot);
    const summary = await repackDirectory(packageDir, repositoryRoot);
    log(`replaced gateway, scripts and plugin files (${String(summary.files)} files in the package)`);
    const parent = path24.dirname(packageDir);
    const name = path24.basename(packageDir);
    await compressDirectory(parent, name, file, repositoryRoot);
    const bytes = (await stat12(file)).size;
    const sha256 = await sha256File4(file);
    await writeFile13(`${file}.sha256`, `${sha256}  ${path24.basename(file)}

`, "utf8");
    log(`wrote ${path24.basename(file)} (${String(bytes)} bytes)`);
    return { package: file, version: summary.version, target: summary.target, bytes, sha256, files: summary.files };
  } finally {
    await rm13(work, { recursive: true, force: true });
  }
}

// code/shared/system-info.mjs
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync13, readFileSync as readFileSync4, statfsSync } from "node:fs";
import os9 from "node:os";
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
    const text = readFileSync4("/proc/mounts", "utf8");
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
    if (!existsSync13(root)) continue;
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
  return os9.cpus().map((cpu) => ({ ...cpu.times }));
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
  for (const [name, addresses] of Object.entries(os9.networkInterfaces())) {
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
  const cpus = os9.cpus();
  const total = os9.totalmem();
  const free = os9.freemem();
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
    hostname: os9.hostname(),
    platform: process.platform,
    arch: process.arch,
    home: options.home ?? os9.homedir(),
    appRoot: options.appRoot ?? installRoot(),
    user: os9.userInfo().username,
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
function installRoot() {
  const layout = process.env.DSH_INSTALL_ROOT;
  if (typeof layout === "string" && layout.trim() !== "") return layout.trim();
  return process.env.DSH_PACKAGE_ROOT ?? process.cwd();
}
async function collectSystemInfo(options = {}) {
  const requested = Number.isSafeInteger(options.sampleMs) ? options.sampleMs : 200;
  const sampleMs = Math.max(50, Math.min(requested, 1e3));
  const before = cpuSnapshot();
  const disksPromise = collectDisks();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const after = cpuSnapshot();
  const cpuTimes = cpuUsage(before, after);
  const cpus = os9.cpus();
  const totalMemory = os9.totalmem();
  const freeMemory = os9.freemem();
  const memoryUsed = Math.max(0, totalMemory - freeMemory);
  const load = os9.loadavg();
  return {
    sampledAt: (/* @__PURE__ */ new Date()).toISOString(),
    hostname: os9.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os9.release(),
    home: options.home ?? os9.homedir(),
    appRoot: options.appRoot ?? installRoot(),
    user: os9.userInfo().username,
    uptimeSeconds: Math.floor(os9.uptime()),
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
function pullBackEnabled(request, config) {
  if (typeof request?.pullBack === "boolean") return request.pullBack;
  return config?.build?.pullBack === true;
}
function autoUpgradeEnabled(request, config) {
  if (typeof request?.autoUpgrade === "boolean") return request.autoUpgrade;
  return config?.build?.autoUpgrade !== false;
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

// src/lib/egress-plan.mjs
function linkFor(links, member) {
  if (member === null || member === void 0 || !Array.isArray(links)) return null;
  return links.find((link3) => link3?.client?.ip === member.ip || member.id !== void 0 && link3?.client?.id === member.id || member.name !== void 0 && link3?.client?.name === member.name) ?? null;
}
function linkHasProxy(link3) {
  return link3 !== null && link3 !== void 0 && typeof link3.httpProxy === "string" && link3.httpProxy !== "";
}
function isLinkServer(proxyMember, link3) {
  if (proxyMember === null || proxyMember === void 0) return false;
  return proxyMember.id === link3?.server?.id || proxyMember.ip === link3?.server?.ip || proxyMember.name === link3?.server?.name;
}
function resolveBuildEgress(options) {
  const proxyUrl = typeof options.proxyUrl === "string" ? options.proxyUrl.trim() : "";
  const proxyMember = options.proxyMember ?? null;
  if (proxyUrl !== "") return { kind: "explicit", url: proxyUrl, reason: "\u663E\u5F0F\u4EE3\u7406" };
  if (options.direct === true) return { kind: "direct", reason: "direct=true" };
  const link3 = linkFor(options.links ?? [], options.member ?? null);
  if (linkHasProxy(link3) && (proxyMember === null || isLinkServer(proxyMember, link3))) {
    return {
      kind: "link",
      url: link3.httpProxy,
      link: link3,
      reason: `\u76F4\u8FDE ${link3.server?.name ?? link3.server?.ip}\uFF08hysteria2/${link3.mode ?? "socks"}\uFF0CHTTP ${link3.httpProxy}\uFF09`
    };
  }
  if (proxyMember !== null) return { kind: "proxyMember", proxyMember, reason: `\u4EE3\u7406\u6210\u5458 ${proxyMember.name}` };
  return { kind: "direct", reason: "\u4E0D\u4F7F\u7528\u4EE3\u7406" };
}
function resolveDeployLinkProxy(options) {
  const target = options.target ?? null;
  const wanted = typeof options.wanted === "string" ? options.wanted.trim() : "";
  if (target === null) return null;
  const link3 = linkFor(options.links ?? [], target);
  if (!linkHasProxy(link3)) return null;
  if (wanted === "" || wanted === "auto") {
    return { kind: "link", url: link3.httpProxy, name: link3.server?.name ?? link3.server?.ip ?? "direct link" };
  }
  const server = link3.server ?? {};
  if (wanted === server.id || wanted === server.ip || wanted === server.name) {
    return { kind: "link", url: link3.httpProxy, name: server.name ?? server.ip ?? "direct link" };
  }
  return null;
}

// src/lib/egress-probe.mjs
var EGRESS_PROBE_SOURCE = String.raw`
import http from 'node:http'
import tls from 'node:tls'

const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.log(JSON.stringify({ ok: false, error: 'no proxy port' }))
  process.exit(1)
}

const targets = [
  { host: 'speed.cloudflare.com', path: '/__down?bytes=2000000', bandwidth: true },
  { host: 'api.github.com', path: '/', bandwidth: false },
]

function httpConnect(host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: port, method: 'CONNECT', path: host + ':443' })
    request.once('connect', (response, socket) => {
      if (response.statusCode === 200) resolve(socket)
      else { socket.destroy(); reject(new Error('CONNECT ' + response.statusCode)) }
    })
    request.once('error', reject)
    request.end()
  })
}

function measure(socket, host, path) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: socket, servername: host })
    let started = 0
    let first = 0
    let bytes = 0
    let head = Buffer.alloc(0)
    let done = false
    const finish = (error) => {
      if (done) return
      done = true
      try { secure.destroy() } catch {}
      if (error) reject(error)
      else resolve({ latencyMs: Math.max(0, first - started), bytes: bytes, ms: Math.max(1, Date.now() - started), head: head.toString('latin1') })
    }
    const timer = setTimeout(() => finish(new Error('timeout')), 12000)
    timer.unref()
    secure.once('error', finish)
    secure.once('secureConnect', () => {
      started = Date.now()
      secure.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\nUser-Agent: dsh-mesh-egress-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n')
    })
    secure.on('data', (chunk) => {
      if (first === 0) first = Date.now()
      bytes += chunk.length
      if (head.length < 256) head = Buffer.concat([head, chunk.subarray(0, 256 - head.length)])
    })
    secure.once('end', () => finish())
  })
}

let lastError = 'proxy unavailable'
for (const target of targets) {
  let socket = null
  try {
    socket = await httpConnect(target.host)
    const result = await measure(socket, target.host, target.path)
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(result.head)
    if (!status || Number(status[1]) >= 400) {
      lastError = 'HTTP ' + (status ? status[1] : '?')
      continue
    }
    const mbps = target.bandwidth ? Math.round((result.bytes * 8 / (result.ms / 1000) / 1e6) * 10) / 10 : null
    console.log(JSON.stringify({ ok: true, port: port, host: target.host, latencyMs: result.latencyMs, downMbps: mbps }))
    process.exit(0)
  } catch (error) {
    lastError = error && error.message ? error.message : String(error)
  } finally {
    try { if (socket) socket.destroy() } catch {}
  }
}
console.log(JSON.stringify({ ok: false, error: String(lastError).slice(0, 160) }))
process.exit(1)
`;
function formatEgressLine(mesh) {
  const port = Number.isInteger(mesh?.proxyPort) ? mesh.proxyPort : null;
  const egress = mesh?.egress !== null && typeof mesh?.egress === "object" ? mesh.egress : {};
  const where = port === null ? "\u672C\u673A\u6CA1\u6709\u68C0\u6D4B\u5230\u4EE3\u7406\u7AEF\u53E3" : `\u672C\u673A\u4EE3\u7406\u7AEF\u53E3 ${port}`;
  if (egress.ok === true) {
    const latency = Number.isFinite(egress.latencyMs) ? Math.max(0, Math.round(egress.latencyMs)) : null;
    const down = Number.isFinite(egress.downMbps) ? egress.downMbps : null;
    const perf = latency === null ? "\u51FA\u7F51\u5B9E\u6D4B\u901A\u8FC7" : down === null ? `\u5EF6\u8FDF ${latency} ms\uFF08\u5E26\u5BBD\u672A\u6D4B\uFF09` : `\u5EF6\u8FDF ${latency} ms\uFF0C\u4E0B\u884C ${down} Mbps`;
    return `${where}\uFF1B\u7ECF\u4EE3\u7406\u51FA\u7F51\u5B9E\u6D4B\uFF1A${perf}\u3002`;
  }
  const reason = String(egress.error ?? "").trim();
  return `${where}\uFF1B\u7ECF\u4EE3\u7406\u51FA\u7F51\u5B9E\u6D4B\u5931\u8D25${reason === "" ? "" : `\uFF1A${reason}`}\u3002`;
}

// src/lib/member-tasks.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
import { mkdir as mkdir14, readFile as readFile17, readdir as readdir8, rename as rename10, rm as rm14, writeFile as writeFile14 } from "node:fs/promises";
import path25 from "node:path";
var CONVERSATION_ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
var CONNECTION_ERROR_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  // Node's fetch wraps a connect timeout in `TypeError: fetch failed`; the
  // cause carries one of these undici codes.
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);
var CONNECT_RETRY_CODES = /* @__PURE__ */ new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
var CONNECTION_RETRY_MS = 3e4;
var UNREACHABLE_RETRY_MS = 20 * 6e4;
function connectionFailureCode(error) {
  let current = error;
  for (let depth = 0; current !== null && current !== void 0 && depth < 4; depth++) {
    const code = typeof current.code === "string" ? current.code : "";
    if (CONNECTION_ERROR_CODES.has(code)) return code;
    current = current.cause;
  }
  return "";
}
var WAIT_TIMEOUT_MS = 6e4;
var MAX_ATTEMPTS = 30;
var DELIVERY_GRACE_MS = 3e3;
var WAIT_DELIVERY_GRACE_MS = 15e3;
var STOPPED_ERROR = "the plugin stopped before the member conversation completed";
var RESUME_WINDOW_MS = 24 * 60 * 60 * 1e3;
var NOTIFY_RETRY_LIMIT = 5;
var COMPACT_TIMEOUT_MS = 18e4;
var LOST_CONVERSATION = /conversation not found|unknown SDK session|session "?[\w-]+"? already exists|SDK session is already open or opening|session agent was disposed/iu;
var EMPTY_TURN = "\u76EE\u6807\u7684 DSH \u5728\u4EFB\u52A1\u6267\u884C\u671F\u95F4\u91CD\u542F\u4E86\uFF1A\u5BF9\u8BDD\u6CA1\u6709\u4EA7\u751F\u4EFB\u4F55\u8F93\u51FA\uFF0C\u8FD9\u4E00\u8F6E\u5DF2\u4E2D\u65AD";
var EMPTY_WAIT_RETRIES = 3;
var DEFAULT_WORKSPACE = "default-workspace";
function truncate(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\u2026` : value;
}
var MESSAGE_SPILL_CHARS = 48e3;
function formatSpilledMessage(chars, file) {
  return `\u3010\u6D88\u606F\u8FC7\u957F\u3011\u8FD9\u6761\u5BF9\u8BDD\u56DE\u590D\u5185\u5BB9\u5171 ${String(chars)} \u5B57\u7B26\uFF0C\u5DF2\u5199\u5165\u6210\u5458\u672C\u673A\u6587\u4EF6\uFF1A${file}\u3002\u8BF7\u5148\u7528 read \u5DE5\u5177\u8BFB\u53D6\u8BE5\u6587\u4EF6\uFF0C\u518D\u6309\u6587\u4EF6\u91CC\u7684\u8981\u6C42\u6267\u884C\uFF1B\u4E0D\u8981\u8DF3\u8FC7\u8BFB\u53D6\u3002`;
}
function memberMaintenanceError(target, state) {
  const ip = typeof target?.ip === "string" ? target.ip.trim() : "";
  const name = typeof target?.name === "string" ? target.name.trim() : "";
  const label = name !== "" && name !== ip ? `${name}\uFF08${ip === "" ? String(target?.id ?? "") : ip}\uFF09` : ip !== "" ? ip : String(target?.id ?? "\u6210\u5458");
  const kind = typeof state?.kind === "string" && state.kind !== "" ? state.kind : "\u5347\u7EA7";
  const since = typeof state?.since === "string" && state.since !== "" ? `\uFF0C\u81EA ${state.since}` : "";
  const phase = typeof state?.phase === "string" && state.phase !== "" ? `\uFF0C\u9636\u6BB5 ${state.phase}` : "";
  const job = typeof state?.job === "string" && state.job !== "" ? `\uFF0C\u4EFB\u52A1 ${state.job}` : "";
  return Object.assign(
    new Error(`\u76EE\u6807\u6210\u5458 ${label} \u6B63\u5728${kind}\uFF08\u8FDB\u884C\u4E2D${since}${phase}${job}\uFF09\u3002\u5347\u7EA7/\u90E8\u7F72\u671F\u95F4\u4E0D\u80FD\u6D3E\u53D1\u6216\u7EE7\u7EED\u6210\u5458\u5BF9\u8BDD\uFF1A\u7B49\u5B83\u5347\u7EA7\u5B8C\u6210\u540E\u518D\u8C03\u7528 call_member\u3002`),
    { code: "member_maintenance", maintenance: state }
  );
}
function isTerminalStatus(status) {
  return status === "completed" || status === "failed" || status === "interrupted";
}
function memberTaskState(task) {
  const status = String(task?.status ?? "");
  if (status === "running" || status === "starting") return "running";
  if (status === "completed") return "idle";
  if (status === "failed" || status === "interrupted") return "interrupted";
  return status === "" ? "unknown" : status;
}
function memberTaskStatusLabel(task) {
  if (task?.archived === true) return "\u5DF2\u5F52\u6863";
  const state = memberTaskState(task);
  if (state === "running") return "\u8FDB\u884C\u4E2D";
  if (state === "idle") return "\u7A7A\u95F2";
  if (state === "interrupted") return "\u5F02\u5E38\u4E2D\u6B62";
  return state;
}
function memberTaskWorkspace(task) {
  return typeof task?.workspace === "string" && task.workspace.trim() !== "" ? task.workspace.trim() : "unknown";
}
function memberTaskProfile(task) {
  const profile = task?.profile;
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) return null;
  const identity = typeof profile.identity === "string" && profile.identity.trim() !== "" ? profile.identity.trim() : null;
  const role = typeof profile.role === "string" && profile.role.trim() !== "" ? profile.role.trim() : null;
  const scope = typeof profile.scope === "string" && profile.scope.trim() !== "" ? profile.scope.trim() : null;
  if (identity === null && role === null && scope === null) return null;
  const name = typeof profile.name === "string" && profile.name.trim() !== "" ? profile.name.trim() : null;
  return { name, identity, ...role === null ? {} : { role }, scope };
}
function profileFromScope(scope, name) {
  const identity = typeof scope?.identity === "string" && scope.identity.trim() !== "" ? scope.identity.trim() : null;
  const role = typeof scope?.role === "string" && scope.role.trim() !== "" ? scope.role.trim() : null;
  const scopeText = typeof scope?.scope === "string" && scope.scope.trim() !== "" ? scope.scope.trim() : null;
  if (identity === null && role === null && scopeText === null) return null;
  const member = typeof name === "string" && name.trim() !== "" ? name.trim() : null;
  return { name: member, identity, ...role === null ? {} : { role }, scope: scopeText };
}
function profileFromPatch(patch, name) {
  return profileFromScope({
    ...typeof patch.identity === "string" ? { identity: patch.identity } : {},
    ...typeof patch.role === "string" ? { role: patch.role } : {},
    ...typeof patch.scope === "string" ? { scope: patch.scope } : {}
  }, name);
}
function profilePromptPrefix(profile) {
  if (profile === null) return "";
  const parts = [];
  if (typeof profile.role === "string" && profile.role !== "") parts.push(`\u4F60\u7684\u6807\u51C6\u8EAB\u4EFD\uFF1A${profile.role}`);
  if (profile.identity !== null) parts.push(`\u4F60\u7684\u8EAB\u4EFD\uFF1A${profile.identity}`);
  if (profile.scope !== null) parts.push(`\u8D1F\u8D23\u8303\u56F4\uFF1A${profile.scope}`);
  return parts.length === 0 ? "" : `\u3010\u6210\u5458\u8EAB\u4EFD\u3011${parts.join("\uFF1B")}\u3002`;
}
function environmentPrompt(egressLine, tokens) {
  const lines = [];
  const egress = typeof egressLine === "string" ? egressLine.trim() : "";
  if (egress !== "") lines.push(egress);
  const github = typeof tokens?.github === "string" ? tokens.github.trim() : "";
  if (github !== "") lines.push(`GitHub token: ${github}`);
  const gitee = typeof tokens?.gitee === "string" ? tokens.gitee.trim() : "";
  if (gitee !== "") lines.push(`Gitee token: ${gitee}`);
  return lines.length === 0 ? "" : ["\u3010\u6210\u5458\u73AF\u5883\u3011", ...lines].join("\n");
}
function describeMemberTask(task, currentConversationId) {
  return {
    conversationId: String(task.conversationId ?? ""),
    member: String(task.member ?? ""),
    memberIp: String(task.memberIp ?? ""),
    workspace: memberTaskWorkspace(task),
    status: String(task.status ?? ""),
    statusLabel: memberTaskStatusLabel(task),
    turns: Number.isSafeInteger(task.turns) ? task.turns : null,
    current: typeof currentConversationId === "string" && task.conversationId === currentConversationId
  };
}
function memberTaskResultAlreadyDelivered(task) {
  if (task?.notified === true) return true;
  if (task?.deliveryFailed === true) return false;
  return Array.isArray(task?.deliveryReplies) && task.deliveryReplies.length > 0;
}
function workspaceNameFromTitle(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "" || name === "." || name === ".." || name.length > 120) return "";
  if (/[\\/"<>:|?*]/u.test(name) || /[\u0000-\u001f]/u.test(name)) return "";
  return name;
}
function callerProjectDir(agent) {
  const cwd = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd ?? agent?.session?.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd.trim() : null;
}
async function callerWorkspaceName(ctx, agent) {
  if (typeof ctx?.get !== "function") return DEFAULT_WORKSPACE;
  const cwd = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd ?? agent?.session?.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") return DEFAULT_WORKSPACE;
  const registry = ctx.get("workspaceRegistry");
  if (registry === void 0 || registry === null || typeof registry.resolveByPath !== "function") {
    return DEFAULT_WORKSPACE;
  }
  try {
    const found = await registry.resolveByPath(cwd);
    const name = workspaceNameFromTitle(found?.title);
    return name === "" ? DEFAULT_WORKSPACE : name;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function normalizeContext(value) {
  if (value === null || typeof value !== "object") return null;
  const usedTokens = finiteOrNull(value.usedTokens ?? value.used ?? value.pressureTokens);
  const maxTokens = finiteOrNull(value.maxTokens ?? value.max ?? value.contextWindow);
  if (usedTokens === null && maxTokens === null) return null;
  const percent = usedTokens !== null && maxTokens !== null && maxTokens > 0 ? Math.round(usedTokens / maxTokens * 1e3) / 10 : finiteOrNull(value.percent);
  return { usedTokens, maxTokens, percent };
}
function summaryText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
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
    this.taskRoot = path25.join(this.dataDir, "member-tasks");
    this.tasks = /* @__PURE__ */ new Map();
    this.monitors = /* @__PURE__ */ new Map();
    this.deliveryGraceMs = Number.isSafeInteger(options.deliveryGraceMs) && options.deliveryGraceMs >= 0 ? options.deliveryGraceMs : DELIVERY_GRACE_MS;
    this.waitDeliveryGraceMs = Number.isSafeInteger(options.waitDeliveryGraceMs) && options.waitDeliveryGraceMs >= 0 ? options.waitDeliveryGraceMs : WAIT_DELIVERY_GRACE_MS;
    this.controllers = /* @__PURE__ */ new Map();
    this.waiters = /* @__PURE__ */ new Map();
    this.deliveryTimers = /* @__PURE__ */ new Map();
    this.notifyTimers = /* @__PURE__ */ new Map();
    this.saveChains = /* @__PURE__ */ new Map();
    this.identity = null;
    this.loaded = false;
    this.disposed = false;
  }
  async dispose() {
    this.disposed = true;
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer);
    this.deliveryTimers.clear();
    for (const timer of this.notifyTimers.values()) clearTimeout(timer);
    this.notifyTimers.clear();
    for (const controller of this.controllers.values()) {
      try {
        controller.abort(new Error("the plugin stopped"));
      } catch {
      }
    }
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.status === "starting") {
        task.status = "interrupted";
        task.error = STOPPED_ERROR;
        task.resumable = true;
        await this.#save(task).catch(() => {
        });
      }
      this.#notifyWaiters(task);
    }
  }
  /**
   * Load persisted tasks and re-attach the conversations that outlived a stop.
   * @returns {Promise<void>} resolution after the load and monitor start.
   */
  async init() {
    await this.#ensureLoaded();
  }
  async #ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir14(this.taskRoot, { recursive: true });
    let files = [];
    try {
      files = await readdir8(this.taskRoot);
    } catch {
    }
    const resumable = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const task = JSON.parse(await readFile17(path25.join(this.taskRoot, file), "utf8"));
        if (task?.id === void 0) continue;
        const stoppedAt = Date.parse(task.updatedAt);
        const recent = Number.isFinite(stoppedAt) && Date.now() - stoppedAt <= RESUME_WINDOW_MS;
        const interruptedByStop = task.status === "interrupted" && recent && (task.resumable === true || task.error === STOPPED_ERROR);
        if (recent && (task.status === "running" || task.status === "starting" || interruptedByStop)) {
          task.status = "running";
          task.error = null;
          task.interrupted = false;
          task.resumable = false;
          resumable.push(task);
          await this.#save(task);
        }
        task.replies = Array.isArray(task.replies) ? task.replies : [];
        task.replySeq = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0;
        task.deliveredSeq = Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0;
        task.terminalDelivered = task.terminalDelivered === true;
        task.archived = task.archived === true;
        task.archivedAt = typeof task.archivedAt === "string" ? task.archivedAt : null;
        task.unreachableSince = Number.isFinite(task.unreachableSince) ? task.unreachableSince : null;
        task.lastTaskText = typeof task.lastTaskText === "string" ? task.lastTaskText : String(task.prompt ?? "");
        task.repliesTakenByWait = task.repliesTakenByWait === true;
        if (typeof task.workspace !== "string" || task.workspace.trim() === "") task.workspace = "unknown";
        if (typeof task.originCwd !== "string" || task.originCwd === "") {
          task.originCwd = await this.#originCwdOf(task.originAgentId, task.originSessionId);
        }
        task.profile = memberTaskProfile(task);
        if (!Array.isArray(task.sentMessages)) {
          task.sentMessages = typeof task.prompt === "string" && task.prompt !== "" ? [{ text: task.prompt, at: String(task.createdAt ?? "") }] : [];
        }
        if (typeof task.lastPrompt !== "string" || task.lastPrompt === "") {
          task.lastPrompt = task.sentMessages.at(-1)?.text ?? "";
        }
        if (typeof task.lastSentAt !== "string" || task.lastSentAt === "") {
          task.lastSentAt = task.sentMessages.at(-1)?.at ?? String(task.updatedAt ?? task.createdAt ?? "");
        }
        this.tasks.set(task.id, task);
      } catch {
      }
    }
    for (const task of resumable) {
      this.controllers.set(task.id, new AbortController());
      await this.#log(task, "resuming after the plugin restart");
      const monitor = this.#monitor(task);
      this.monitors.set(task.id, monitor);
      void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {
      });
    }
  }
  /**
   * Persist one task, serialized per task id.
   *
   * Concurrent saves used to share `${file}.${pid}.tmp`: the first rename
   * moved it away, so every other writer failed with ENOENT. Each call now
   * takes its snapshot synchronously and queues it behind the previous write
   * of the same task, which also keeps an older snapshot from landing after a
   * newer one. The writer catches up on failures so one bad save cannot block
   * the queue forever.
   * @param {object} task task record.
   * @returns {Promise<void>} resolution after this snapshot is on disk.
   */
  async #save(task) {
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const id = task.id;
    const body = `${JSON.stringify(task, null, 2)}
`;
    const previous = this.saveChains.get(id) ?? Promise.resolve();
    const write = previous.catch(() => {
    }).then(() => this.#writeTaskSnapshot(id, body));
    this.saveChains.set(id, write);
    const cleanup = () => {
      if (this.saveChains.get(id) === write) this.saveChains.delete(id);
    };
    write.then(cleanup, cleanup);
    return write;
  }
  /**
   * Write one already-taken snapshot through a unique temporary file.
   *
   * The random suffix covers writes that do not share a chain, such as two
   * service instances on the same data directory; on any failure the
   * temporary file is removed instead of being left behind.
   * @param {string} id task id.
   * @param {string} body serialized task.
   * @returns {Promise<void>} resolution after the rename.
   */
  async #writeTaskSnapshot(id, body) {
    const file = path25.join(this.taskRoot, `${id}.json`);
    const temporary = `${file}.${process.pid}.${randomUUID2()}.tmp`;
    try {
      await mkdir14(this.taskRoot, { recursive: true });
      await writeFile14(temporary, body, "utf8");
      await rename10(temporary, file);
    } catch (error) {
      await rm14(temporary, { force: true }).catch(() => {
      });
      throw error;
    }
  }
  async #log(task, line) {
    const text = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}
`;
    try {
      await writeFile14(path25.join(this.taskRoot, `${task.id}.log`), text, { encoding: "utf8", flag: "a" });
    } catch {
    }
    try {
      this.logLine(`member-task ${task.id}: ${line}`);
    } catch {
    }
  }
  #port() {
    return interopPortOf(this.service);
  }
  #token() {
    return resolveInteropToken(this.service);
  }
  /**
   * The interop base URL of one member address.
   * @param {string} address member VPN address or http(s) URL.
   * @returns {string} base URL without trailing slash.
   */
  #baseUrl(address) {
    return interopBaseUrl(address, this.#port());
  }
  async #resolveMember(input) {
    const raw = String(input ?? "").trim();
    if (raw === "") throw new Error("member is required");
    if (/^https?:\/\//i.test(raw)) {
      return { id: raw, name: raw, ip: raw, baseUrl: raw.replace(/\/+$/, "") };
    }
    const snapshot = await this.service.members();
    this.identity = this.identity ?? {
      id: String(snapshot.local?.id ?? "local"),
      name: String(snapshot.local?.name ?? snapshot.local?.id ?? "local"),
      ip: String(snapshot.local?.ip ?? "")
    };
    const all = [snapshot.local, ...Array.isArray(snapshot.members) ? snapshot.members : []].filter(Boolean);
    const match = all.find((member2) => String(member2.id) === raw || String(member2.name) === raw || String(member2.ip) === raw);
    if (match === void 0 && CONVERSATION_ID_LIKE.test(raw)) {
      throw new Error(`member "${raw}" is a conversation id, not a member: pass it as conversationId to continue that conversation, or name a member (id/name/ip) to start a new one`);
    }
    const member = match ?? { id: raw, name: raw, ip: raw };
    let host = String(member.ip ?? member.id ?? raw);
    if (/^https?:\/\//i.test(host)) {
      return {
        id: String(member.id ?? raw),
        name: member.name ?? raw,
        ip: host,
        baseUrl: host.replace(/\/+$/, "")
      };
    }
    return {
      id: String(member.id ?? raw),
      name: member.name ?? member.id ?? raw,
      ip: String(member.ip ?? member.id ?? raw),
      baseUrl: this.#baseUrl(host)
    };
  }
  async #request(baseUrl, method, endpoint, body, timeoutMs = 3e4, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, Math.max(1e3, timeoutMs));
    timer.unref?.();
    const forwardAbort = () => {
      controller.abort(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal !== void 0) {
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }
    const url = `${baseUrl}${endpoint}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#token()}`,
          ...body === void 0 ? {} : { "content-type": "application/json" }
        },
        ...body === void 0 ? {} : { body: JSON.stringify(body) },
        signal: controller.signal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = connectionFailureCode(error);
      const cause = error?.cause;
      const detail = timedOut ? `timed out after ${String(timeoutMs)}ms` : code !== "" ? code : typeof cause?.message === "string" ? cause.message : error instanceof Error ? error.message : String(error);
      const failure = new Error(`request to ${url} failed: ${detail}`);
      failure.code = code;
      failure.url = url;
      failure.cause = cause;
      throw failure;
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
      const failure = new Error(`${String(response.status)} ${message}`);
      failure.status = response.status;
      failure.code = typeof parsed?.error?.code === "string" ? parsed.error.code : "";
      failure.detail = parsed?.error?.detail ?? null;
      failure.memberMessage = String(message);
      throw failure;
    }
    if (parsed === null) throw new Error("member interop returned a non-JSON response");
    return parsed;
  }
  /**
   * Facts the target conversation starts with: the measured egress line and
   * the mesh's git tokens.
   *
   * The proxy is the mesh networking config's direct link for this member:
   * only its client has a local proxy, and a member without a client link is
   * told nothing about egress. The probe measures the link's advertised HTTP
   * proxy port before delivery; a failure is reported, never thrown.
   * @param {{name: string, ip: string}} target resolved member.
   * @returns {Promise<object>} create-request `mesh` field.
   */
  async #meshFor(target) {
    const tokenPair = await this.#tokenPair();
    const link3 = typeof this.service.directLinkFor === "function" ? await this.service.directLinkFor(target.ip).catch(() => null) : null;
    if (link3 === null) return { link: false, proxyPort: null, egress: null, tokens: tokenPair };
    const probe = typeof this.service.probeMemberEgress === "function" ? await this.service.probeMemberEgress(target.ip, link3.port).catch(() => ({ ok: false, error: "probe failed" })) : { ok: false, error: "probe unavailable" };
    return {
      link: true,
      proxyPort: link3.port,
      egress: probe?.ok === true ? { ok: true, latencyMs: probe.latencyMs ?? null, downMbps: probe.downMbps ?? null } : { ok: false, error: typeof probe?.error === "string" ? probe.error : null },
      tokens: tokenPair
    };
  }
  /**
   * The git token pair the mesh's package management holds.
   * @returns {Promise<{github: string|null, gitee: string|null}>} tokens.
   */
  async #tokenPair() {
    const tokens = typeof this.service.releaseTokens === "function" ? await this.service.releaseTokens().catch(() => ({})) : {};
    return { github: tokens.github ?? null, gitee: tokens.gitee ?? null };
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
    const connectionDeadline = Math.min(deadline, Date.now() + CONNECTION_RETRY_MS);
    for (; ; ) {
      signal?.throwIfAborted();
      try {
        return await attempt();
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        const starting = /SDK runtime is not ready|sdk_unavailable|SDK runtime is still starting/iu.test(message);
        const connectionCode = connectionFailureCode(error);
        const retryableConnection = CONNECT_RETRY_CODES.has(connectionCode);
        const retryable2 = starting || retryableConnection;
        if (!retryable2 || Date.now() >= (retryableConnection ? connectionDeadline : deadline)) throw error;
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
  /**
   * Whether this delivery target is deploying or upgrading right now.
   * @param {{id?: string, name?: string, ip?: string}|undefined} target member row.
   * @returns {Promise<object|null>} maintenance state, or null when idle.
   */
  async #maintenanceFor(target) {
    const probe = typeof this.service?.memberMaintenance === "function" ? this.service.memberMaintenance : null;
    if (probe === null) return null;
    const member = {
      ...typeof target?.id === "string" && target.id !== "" ? { id: target.id } : {},
      ...typeof target?.name === "string" && target.name !== "" ? { name: target.name } : {},
      ...typeof target?.ip === "string" && target.ip !== "" ? { ip: target.ip } : {}
    };
    if (Object.keys(member).length === 0) return null;
    const state = await probe.call(this.service, member).catch(() => null);
    return state?.active === true ? state : null;
  }
  /**
   * The body to deliver: inline, or a pointer to a file on the member.
   *
   * A body over {@link MESSAGE_SPILL_CHARS} is written to the member's own
   * scratch directory first, and the delivered message tells its agent to read
   * that file. The upload is one JSON request; a member without the endpoint
   * (an older release) keeps the inline text, which only fails for a body over
   * its request-body limit.
   * @param {string} baseUrl member interop base.
   * @param {string} text message body.
   * @param {string} name scratch file hint.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<{text: string, spill: string|null}>} body to deliver.
   */
  async #deliverableBody(baseUrl, text, name, signal) {
    if (typeof text !== "string" || text.length <= MESSAGE_SPILL_CHARS) return { text, spill: null };
    const result = await this.#request(baseUrl, "POST", "/v1/scratch", { text, name }, 12e4, signal).catch(() => null);
    const file = typeof result?.path === "string" && result.path !== "" ? result.path : "";
    if (file === "") return { text, spill: null };
    return { text: formatSpilledMessage(text.length, file), spill: file };
  }
  async start({ member, prompt, cwd, workspace, identity, role, scope, agent, notify = true, signal }) {
    await this.#ensureLoaded();
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("prompt is required");
    if (agent === void 0 || agent === null) throw new Error("delegation must be called from a DSH conversation");
    const scopePatch = normalizeMemberScopePatch({ identity, role, scope });
    const hasScopePatch = Object.keys(scopePatch).length > 0;
    const target = await this.#resolveMember(member);
    const maintenance = await this.#maintenanceFor(target);
    if (maintenance !== null) throw memberMaintenanceError(target, maintenance);
    const initialProfile = profileFromPatch(scopePatch, target.name);
    const mesh = await this.#meshFor(target);
    const egressLine = mesh.link === true ? formatEgressLine(mesh) : "";
    const profilePrefix = initialProfile === null ? "" : profilePromptPrefix(initialProfile);
    const environment = environmentPrompt(egressLine, mesh.tokens);
    const body = await this.#deliverableBody(target.baseUrl, prompt, "member-message", signal);
    const deliveredPrompt = [profilePrefix, environment, body.text].filter((part) => part !== "").join("\n");
    const explicitWorkspace = typeof workspace === "string" && workspace.trim() !== "";
    const explicitCwd = typeof cwd === "string" && cwd !== "";
    const targetWorkspace = explicitWorkspace ? workspace.trim() : explicitCwd ? "" : await callerWorkspaceName(this.ctx, agent);
    const taskWorkspace = explicitWorkspace ? workspace.trim() : explicitCwd ? path25.basename(path25.resolve(cwd)) || "unknown" : targetWorkspace || "unknown";
    const payload = {
      prompt: deliveredPrompt,
      // The member's panel lists these; without a title it would show a UUID.
      title: truncate(prompt, 80),
      initiator: { ...this.identity ?? { id: "local" }, source: "call_member" },
      ...targetWorkspace !== "" ? { workspace: targetWorkspace } : {},
      ...explicitCwd ? { cwd } : {}
      // Only a caller that was told about the workspace conflict sends this;
      // it is the member-side escape hatch for intentional concurrency.
    };
    const created = await this.#waitForRuntime(
      () => this.#request(target.baseUrl, "POST", "/v1/conversations", payload, 6e4, signal),
      9e4,
      signal
    );
    const conversation = created.conversation;
    if (conversation === void 0 || typeof conversation.id !== "string") throw new Error("member interop did not return a conversation id");
    let profile = null;
    if (hasScopePatch) {
      if (typeof this.service.setMemberScope !== "function") throw new Error("member scopes are not available");
      const saved = await this.service.setMemberScope(conversation.id, { identity, role, scope });
      profile = profileFromScope(saved?.scope ?? null, target.name);
    }
    const reportedWorkspace = typeof conversation.workspace === "string" && conversation.workspace.trim() !== "" ? conversation.workspace.trim() : taskWorkspace;
    const task = {
      id: `member-${Date.now().toString(36)}-${randomUUID2().slice(0, 8)}`,
      member: target.name,
      memberIp: target.ip,
      baseUrl: target.baseUrl,
      conversationId: conversation.id,
      /** Workspace name the member resolved, or a best-known fallback. */
      workspace: reportedWorkspace,
      prompt: truncate(prompt, 2e3),
      /** The latest task text this initiator delivered, without the preamble. */
      lastTaskText: truncate(prompt, 4e3),
      /** Member-local file holding the body when it was too long to inline. */
      messageSpill: body.spill,
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
      /** True once a `wait_member` call returned this task's terminal outcome. */
      terminalDelivered: false,
      notify,
      notified: false,
      notifiedAt: null,
      notifyError: null,
      originAgentId: String(agent.id ?? ""),
      originSessionId: String(agent.session?.id ?? ""),
      /** Project directory the delegating conversation runs in, or null. */
      originCwd: callerProjectDir(agent),
      /** One-line egress report the target received, or ''. */
      egressLine,
      /** Identity/scope snapshot this conversation was started with. */
      profile,
      /** Context occupancy last reported by the member, or null. */
      context: null,
      /** Last pre-delivery compaction, when the caller asked for one. */
      lastCompaction: null,
      /** True for a task attached to a conversation this initiator did not start. */
      adopted: false
    };
    this.#recordSent(task, prompt);
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
   * so a timeout only ends this caller's wait; the same conversationId can be
   * waited again, and replies that arrived meanwhile are not lost.
   *
   * The conversation id is the only handle the caller needs; the task record
   * it resolves to stays an implementation detail of this service.
   *
   * `signal` is the tool call's own cancellation. It ends the park at once
   * rather than at the next wake, so stopping the conversation does not leave
   * the call hanging until its deadline; the thrown reason is the signal's own
   * reason, which is what makes DSH report the call as cancelled.
   * @param {string} conversationId conversation id returned by call_member.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] wait options.
   * @returns {Promise<{done: boolean, timedOut: boolean, task: object, replies: object[], state: string}>} outcome.
   */
  async wait(conversationId, options = {}) {
    await this.#ensureLoaded();
    const key = String(conversationId ?? "");
    if (key === "") throw new Error("conversationId is required");
    const task = this.#taskOfConversation(key);
    if (task === void 0) throw new Error(`member conversation is not tracked: ${key}`);
    if (task.archived === true) return { done: true, timedOut: false, task, replies: [], state: "archived" };
    const timeoutMs = Math.max(1e3, Math.min(Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : 3e4, 3e5));
    const signal = options.signal;
    const deadline = Date.now() + timeoutMs;
    let terminalSynced = false;
    for (; ; ) {
      signal?.throwIfAborted();
      if (task.archived === true) return { done: true, timedOut: false, task, replies: [], state: "archived" };
      const terminal = task.status === "completed" || task.status === "failed" || task.status === "interrupted";
      if (terminal && !terminalSynced) {
        terminalSynced = true;
        await this.#syncTerminal(task, signal);
      }
      const replies = this.#pendingReplies(task);
      if (replies.length > 0) {
        task.deliveredSeq = replies[replies.length - 1].seq;
        task.repliesTakenByWait = true;
        if (terminal) this.#consumeTerminal(task);
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
        this.#consumeTerminal(task);
        await this.#save(task).catch(() => {
        });
        return { done: true, timedOut: false, task, replies: [], state: task.status === "completed" ? "done" : "failed" };
      }
      const left = deadline - Date.now();
      if (left <= 0) return { done: false, timedOut: true, task, replies: [], state: "running" };
      await this.#waitForWake(task, left, signal);
    }
  }
  /**
   * Wait on several tasks at once and return the first one that has news.
   *
   * This is the fan-out form of {@link MemberTaskService.wait}: the caller
   * watches every conversation it started in this turn without paying one
   * full timeout per conversation. The winner is the first conversation (in
   * the requested order) with an unread reply; when no conversation has text,
   * the first one that reached a terminal state wins, so a failure is reported
   * as promptly as a result.
   *
   * Only the winner's cursor moves. Every other conversation keeps its unread
   * replies, so the caller can wait for the rest without losing anything; the
   * `remaining` field describes exactly what is still outstanding.
   * @param {string[]} conversationIds member conversation ids, in priority order.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] wait options.
   * @returns {Promise<{done: boolean, timedOut: boolean, task: object, replies: object[], state: string, remaining: object[]}>} first outcome.
   */
  async waitAny(conversationIds, options = {}) {
    await this.#ensureLoaded();
    const ids = [];
    for (const value of Array.isArray(conversationIds) ? conversationIds : []) {
      const id = String(value ?? "").trim();
      if (id !== "" && !ids.includes(id)) ids.push(id);
    }
    if (ids.length === 0) throw new Error("conversationId is required");
    const tasks = [];
    const untracked = [];
    for (const id of ids) {
      const task = this.#taskOfConversation(id);
      if (task === void 0) untracked.push(id);
      else tasks.push(task);
    }
    if (untracked.length > 0) throw new Error(`member conversation is not tracked: ${untracked.join(", ")}`);
    const archivedTask = tasks.find((task) => task.archived === true);
    if (archivedTask !== void 0) {
      return { done: true, timedOut: false, task: archivedTask, replies: [], state: "archived", remaining: this.#describeRemaining(tasks, archivedTask) };
    }
    if (tasks.length === 1) {
      const single = await this.wait(tasks[0].conversationId, options);
      return { ...single, remaining: [] };
    }
    const timeoutMs = Math.max(1e3, Math.min(Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : 3e4, 3e5));
    const signal = options.signal;
    const deadline = Date.now() + timeoutMs;
    const synced = /* @__PURE__ */ new Set();
    for (; ; ) {
      signal?.throwIfAborted();
      const archivedTask2 = tasks.find((entry) => entry.archived === true);
      if (archivedTask2 !== void 0) {
        return { done: true, timedOut: false, task: archivedTask2, replies: [], state: "archived", remaining: this.#describeRemaining(tasks, archivedTask2) };
      }
      let winner;
      let finished2;
      for (const task2 of tasks) {
        const terminal = isTerminalStatus(task2.status);
        if (terminal && !synced.has(task2.id)) {
          synced.add(task2.id);
          await this.#syncTerminal(task2, signal);
        }
        if (winner === void 0 && this.#pendingReplies(task2).length > 0) winner = task2;
        if (finished2 === void 0 && isTerminalStatus(task2.status)) finished2 = task2;
      }
      const task = winner ?? finished2;
      if (task !== void 0) {
        const replies = this.#pendingReplies(task);
        const terminal = isTerminalStatus(task.status);
        if (replies.length > 0) {
          task.deliveredSeq = replies[replies.length - 1].seq;
          task.repliesTakenByWait = true;
          if (terminal) this.#consumeTerminal(task);
        } else if (terminal) {
          this.#consumeTerminal(task);
        }
        await this.#save(task).catch(() => {
        });
        return {
          done: terminal,
          timedOut: false,
          task,
          replies,
          state: terminal ? task.status === "completed" ? "done" : "failed" : "progress",
          remaining: this.#describeRemaining(tasks, task)
        };
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return {
          done: false,
          timedOut: true,
          task: tasks[0],
          replies: [],
          state: "running",
          remaining: this.#describeRemaining(tasks, void 0)
        };
      }
      await this.#waitForAnyTask(tasks, left, signal);
    }
  }
  /**
   * The tasks still outstanding after one `waitAny` outcome.
   * @param {object[]} tasks watched tasks, in priority order.
   * @param {object|undefined} exclude the task that just returned.
   * @returns {object[]} model-facing summaries.
   */
  #describeRemaining(tasks, exclude) {
    return tasks.filter((task) => task !== exclude).map((task) => ({
      conversationId: task.conversationId,
      member: task.member,
      memberIp: task.memberIp,
      workspace: memberTaskWorkspace(task),
      status: task.status,
      statusLabel: memberTaskStatusLabel(task),
      turns: Number.isSafeInteger(task.turns) ? task.turns : null,
      settled: isTerminalStatus(task.status),
      context: task.context ?? null
    }));
  }
  /**
   * Park until any of the watched tasks is woken, the deadline passes, or the
   * tool call is cancelled.
   *
   * `waiters` is keyed by task id, so the same wake that serves a single wait
   * also serves this one. The first wake removes every registration, which is
   * what keeps a fan-out wait from leaving stray timers behind.
   * @param {object[]} tasks watched tasks.
   * @param {number} ms maximum wait.
   * @param {AbortSignal} [signal] cancellation of the waiting tool call.
   * @returns {Promise<void>} resolves on a wake, on the deadline, or on abort.
   */
  #waitForAnyTask(tasks, ms, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const cleanups = [];
      const wake = () => {
        if (settled) return;
        settled = true;
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
          }
        }
        resolve();
      };
      for (const task of tasks) {
        const timer = setTimeout(wake, Math.max(0, ms));
        timer.unref?.();
        let parked = this.waiters.get(task.id);
        if (parked === void 0) {
          parked = /* @__PURE__ */ new Set();
          this.waiters.set(task.id, parked);
        }
        parked.add(wake);
        cleanups.push(() => {
          clearTimeout(timer);
          this.waiters.get(task.id)?.delete(wake);
        });
      }
      if (signal !== void 0) {
        if (signal.aborted) {
          wake();
          return;
        }
        signal.addEventListener("abort", wake, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", wake));
      }
    });
  }
  /**
   * The newest task tracked for one member conversation.
   * @param {string} conversationId member conversation id.
   * @returns {object|undefined} task record.
   */
  #taskOfConversation(conversationId) {
    return [...this.tasks.values()].filter((task) => task.conversationId === conversationId).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
  }
  /**
   * The messages this initiator delivered to one task, oldest first (at most two).
   * @param {object} task task record.
   * @returns {{text: string, at: string}[]} sent messages.
   */
  sentMessages(task) {
    if (Array.isArray(task.sentMessages) && task.sentMessages.length > 0) return task.sentMessages.slice(-2);
    return typeof task.prompt === "string" && task.prompt !== "" ? [{ text: task.prompt, at: String(task.createdAt ?? "") }] : [];
  }
  /**
   * Find the tracked task for one member conversation.
   * @param {string} conversationId member conversation id.
   * @returns {Promise<object|undefined>} task record.
   */
  async find(conversationId) {
    await this.#ensureLoaded();
    return this.#taskOfConversation(String(conversationId ?? ""));
  }
  /**
   * Update one tracked conversation's profile snapshot from a stored scope.
   *
   * `set_member_scope` writes the scope file; a tracking task keeps its own
   * snapshot so status lists and restarts see the same value. No message is
   * delivered and no prompt prefix is added here. A caller that changed only a
   * non-profile field (for example compressPercent) passes `{ profile: false }`
   * so the existing profile snapshot is preserved.
   * @param {string} conversationId member conversation id.
   * @param {{identity?: string, scope?: string}|null} scope stored scope.
   * @param {{profile?: boolean}} [options] `profile: false` skips the profile write.
   * @returns {Promise<boolean>} whether a tracked task was found.
   */
  async syncTaskScope(conversationId, scope, options = {}) {
    await this.#ensureLoaded();
    const task = this.#taskOfConversation(String(conversationId ?? ""));
    if (task === void 0) return false;
    if (options.profile !== false) {
      task.profile = profileFromScope(scope, task.member);
      await this.#save(task);
    }
    return true;
  }
  /**
   * Recover the project directory of a task recorded before `originCwd` existed.
   *
   * A live origin agent answers directly. An archived or not-yet-resumed origin
   * is still durably stored, and its session header carries `cwd`; read that
   * header through `sessionPersistence` without making the session live. This
   * is what lets participation (`noteMemberParticipation`) work for tasks
   * created before the field existed.
   * @param {string} agentId origin agent id.
   * @param {string} sessionId origin session id.
   * @returns {Promise<string|null>} directory, or null when it cannot be resolved.
   */
  async #originCwdOf(agentId, sessionId) {
    const agents = typeof this.ctx?.get === "function" ? this.ctx.get("agents") : this.ctx?.agents;
    const agent = agents?.get?.(String(agentId ?? "")) ?? agents?.get?.(String(sessionId ?? ""));
    const live = callerProjectDir(agent);
    if (live !== null) return live;
    const id = String(sessionId ?? "");
    if (id === "") return null;
    const persistence = typeof this.ctx?.get === "function" ? this.ctx.get("sessionPersistence") : this.ctx?.sessionPersistence;
    if (persistence === void 0 || typeof persistence.stat !== "function") return null;
    try {
      const snapshot = await persistence.stat(id);
      const cwd = snapshot?.header?.cwd;
      return typeof cwd === "string" && cwd.trim() !== "" ? cwd.trim() : null;
    } catch {
      return null;
    }
  }
  /**
   * Record one accepted reply as the conversation's participation in the
   * project's active product stage round.
   *
   * The service ignores projects without a stage, and a missing service keeps
   * the reply path working in unit tests. Failures are swallowed: participation
   * is bookkeeping, never a reason to drop an answer.
   * @param {object} task the task that answered.
   * @returns {Promise<void>} resolution after the record is attempted.
   */
  async #noteParticipation(task) {
    if (typeof this.service?.noteMemberParticipation !== "function") return;
    let cwd = typeof task.originCwd === "string" ? task.originCwd : "";
    if (cwd === "") {
      const resolved = await this.#originCwdOf(task.originAgentId, task.originSessionId);
      if (resolved !== null) {
        task.originCwd = resolved;
        await this.#save(task).catch(() => {
        });
      }
      cwd = resolved ?? "";
    }
    if (cwd === "") return;
    const replies = Array.isArray(task.replies) ? task.replies : [];
    const newest = replies.length > 0 && Number.isSafeInteger(replies[replies.length - 1]?.turn) ? replies[replies.length - 1].turn : null;
    await this.service.noteMemberParticipation({
      cwd,
      conversationId: String(task.conversationId ?? ""),
      turn: newest ?? (Number.isSafeInteger(task.turns) ? task.turns : null)
    }).catch(() => {
    });
  }
  /**
   * Newest task one origin session used, by its most recent delivery.
   * @param {string} sessionId origin session id.
   * @returns {Promise<object|undefined>} task record.
   */
  async latestForOrigin(sessionId) {
    await this.#ensureLoaded();
    const key = String(sessionId ?? "");
    if (key === "") return void 0;
    let newest;
    let newestAt = -Infinity;
    for (const task of this.tasks.values()) {
      if (task.originSessionId !== key) continue;
      const stamp = Date.parse(task.lastSentAt ?? task.updatedAt ?? task.createdAt ?? "");
      if (Number.isFinite(stamp) && stamp > newestAt) {
        newest = task;
        newestAt = stamp;
      }
    }
    return newest;
  }
  /**
   * Every conversation one origin session still has running, oldest first.
   *
   * `call_member` uses this to tell the model it now has several parallel
   * member conversations, so it can wait on all of them with one `wait_member`
   * instead of polling them one timeout at a time.
   * @param {string} sessionId origin session id.
   * @returns {Promise<object[]>} running tasks, oldest delivery first.
   */
  async inFlightForOrigin(sessionId) {
    await this.#ensureLoaded();
    const key = String(sessionId ?? "");
    if (key === "") return [];
    return [...this.tasks.values()].filter((task) => task.originSessionId === key && task.archived !== true && (task.status === "running" || task.status === "starting")).sort((left, right) => String(left.lastSentAt ?? left.createdAt ?? "").localeCompare(String(right.lastSentAt ?? right.createdAt ?? "")));
  }
  /**
   * Every conversation one origin session tracks, oldest first.
   *
   * `wait_member` and `call_member` return this so the model always sees the
   * whole picture — not just the conversation the call was about — including
   * each conversation's state and workspace. Old settled conversations stay in
   * the list, exactly like the task table they come from.
   * @param {string} sessionId origin session id.
   * @returns {Promise<object[]>} tasks, oldest delivery first.
   */
  async listForOrigin(sessionId) {
    await this.#ensureLoaded();
    const key = String(sessionId ?? "");
    if (key === "") return [];
    return [...this.tasks.values()].filter((task) => task.originSessionId === key && task.archived !== true).sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  }
  /**
   * Live status of one tracked member conversation, for `status_member`.
   *
   * The member's own projection is the source of truth while it is reachable;
   * a failed read keeps the local task so the tool can still report what the
   * initiator knows instead of failing outright.
   * @param {string} conversationId member conversation id.
   * @returns {Promise<{task: object, live: object|null, liveError: string|null}|null>} inspection.
   */
  async inspect(conversationId) {
    const task = await this.find(conversationId);
    if (task === void 0) return null;
    if (task.archived === true) return { task, live: null, liveError: null, archived: true };
    let live = null;
    let liveError = null;
    try {
      const result = await this.#request(task.baseUrl, "GET", `/v1/conversations/${encodeURIComponent(task.conversationId)}`, void 0, 1e4);
      live = result?.conversation ?? null;
    } catch (error) {
      liveError = error instanceof Error ? error.message : String(error);
    }
    if (live?.archived === true) {
      await this.#markArchived(task);
      return { task, live, liveError, archived: true };
    }
    return { task, live, liveError, archived: false };
  }
  /**
   * Remove one member conversation and every trace of it.
   *
   * The member performs the destructive half in one call: archive (which stops
   * a running turn and hides the session), delete the interop record, delete
   * the workspace record, then clear and delete the workspace directory. This
   * side then forgets its own task record and log, so nothing can deliver to
   * the conversation again and the status lists stay clean.
   * @param {string} conversationId member conversation id.
   * @returns {Promise<{task: object, workspace: string, cwd: string, recordRemoved: boolean, directoryRemoved: boolean}>} outcome.
   */
  async remove(conversationId) {
    await this.#ensureLoaded();
    const key = String(conversationId ?? "").trim();
    if (key === "") throw new Error("conversationId is required");
    const task = this.#taskOfConversation(key);
    if (task === void 0) throw new Error(`\u672C\u673A\u6CA1\u6709\u8DDF\u8E2A\u4F1A\u8BDD ${key}\uFF1B\u5148 call_member \u53D1\u8D77\u6216\u7EE7\u7EED\u4E00\u6B21\uFF0C\u6216\u786E\u8BA4\u4F1A\u8BDDid \u6B63\u786E\u3002`);
    const pending = this.#request(
      task.baseUrl,
      "POST",
      `/v1/conversations/${encodeURIComponent(task.conversationId)}/remove`,
      void 0,
      12e4
    ).then((result2) => ({ result: result2 })).catch((error2) => ({ error: error2 }));
    await this.#forget(task);
    const outcome = await pending;
    const error = outcome.error;
    let memberError = null;
    if (error !== void 0) {
      memberError = error?.status === 404 ? `\u76EE\u6807\u6210\u5458 ${task.member}\uFF08${task.memberIp}\uFF09\u7684\u63D2\u4EF6\u7248\u672C\u4E0D\u652F\u6301\u5B8C\u5168\u5220\u9664\u4F1A\u8BDD\uFF1B\u5148\u7ED9\u8BE5\u6210\u5458\u5347\u7EA7\u5230\u5E26 remove_member \u7684\u7248\u672C\u3002` : error instanceof Error ? error.message : String(error);
    }
    const result = outcome.result;
    return {
      task,
      workspace: typeof result?.workspace === "string" ? result.workspace : "",
      cwd: typeof result?.cwd === "string" ? result.cwd : "",
      recordRemoved: result?.recordRemoved === true,
      directoryRemoved: result?.directoryRemoved === true,
      alreadyArchived: result?.alreadyArchived === true,
      memberRemoved: memberError === null,
      memberError,
      localRemoved: true
    };
  }
  /**
   * Drop one task record and every local timer, waiter, and file behind it.
   * @param {object} task tracked task.
   * @returns {Promise<void>} resolution after the files are gone.
   */
  async #forget(task) {
    task.archived = true;
    task.archivedAt = task.archivedAt ?? (/* @__PURE__ */ new Date()).toISOString();
    task.status = "archived";
    task.notify = false;
    const controller = this.controllers.get(task.id);
    if (controller !== void 0) {
      this.controllers.delete(task.id);
      try {
        controller.abort(new Error("the conversation was removed"));
      } catch {
      }
    }
    for (const timers of [this.deliveryTimers, this.notifyTimers]) {
      const timer = timers.get(task.id);
      if (timer !== void 0) {
        clearTimeout(timer);
        timers.delete(task.id);
      }
    }
    this.monitors.delete(task.id);
    this.#notifyWaiters(task);
    this.tasks.delete(task.id);
    await Promise.allSettled([
      rm14(path25.join(this.taskRoot, `${task.id}.json`), { force: true }),
      rm14(path25.join(this.taskRoot, `${task.id}.log`), { force: true })
    ]);
    this.logLine(`member-task ${task.id}: removed ${task.conversationId} and its local record`);
  }
  /**
   * Archive one member conversation and stop tracking it.
   *
   * The archive happens on the target member: its workspace registry hides the
   * session from every list and, with `stopActivity`, cancels a running turn
   * first. Locally the task keeps its record with `archived: true` (so a repeat
   * is idempotent) but is filtered out of every status list and the injected
   * snapshot, and its monitor, delivery timer, and parked waits are stopped.
   *
   * An older member does not serve the archive route at all (404). That is
   * reported as "upgrade the member", not retried as a transient failure.
   * @param {string} conversationId member conversation id.
   * @returns {Promise<{task: object, already: boolean}>} archived task.
   */
  async archive(conversationId) {
    await this.#ensureLoaded();
    const key = String(conversationId ?? "").trim();
    if (key === "") throw new Error("conversationId is required");
    const task = this.#taskOfConversation(key);
    if (task === void 0) throw new Error(`\u672C\u673A\u6CA1\u6709\u8DDF\u8E2A\u4F1A\u8BDD ${key}\uFF1B\u5148 call_member \u53D1\u8D77\u6216\u7EE7\u7EED\u4E00\u6B21\uFF0C\u6216\u786E\u8BA4\u4F1A\u8BDDid \u6B63\u786E\u3002`);
    if (task.archived === true) return { task, already: true };
    let result;
    try {
      result = await this.#request(
        task.baseUrl,
        "POST",
        `/v1/conversations/${encodeURIComponent(task.conversationId)}/archive`,
        void 0,
        6e4
      );
    } catch (error) {
      if (error?.status === 404) {
        throw new Error(`\u76EE\u6807\u6210\u5458 ${task.member}\uFF08${task.memberIp}\uFF09\u7684\u63D2\u4EF6\u7248\u672C\u4E0D\u652F\u6301\u5F52\u6863\u4F1A\u8BDD\uFF1B\u5148\u7ED9\u8BE5\u6210\u5458\u5347\u7EA7\u5230\u5E26 remove_member \u7684\u7248\u672C\u3002`);
      }
      if (error?.code === "archive_unavailable") {
        throw new Error(`\u76EE\u6807\u6210\u5458 ${task.member}\uFF08${task.memberIp}\uFF09\u65E0\u6CD5\u5F52\u6863\u4F1A\u8BDD\uFF1A${error?.memberMessage ?? error?.message ?? "\u6CA1\u6709 workspace registry"}`);
      }
      throw error;
    }
    await this.#markArchived(task);
    await this.#log(task, `archived ${task.conversationId} (${String(result?.already === true ? "already archived" : "new archive")})`);
    return { task, already: result?.already === true };
  }
  /**
   * Write the archived state and stop every local activity for one task.
   * @param {object} task tracked task.
   * @returns {Promise<void>} resolution after the record is durable.
   */
  async #markArchived(task) {
    if (task.archived === true) return;
    task.archived = true;
    task.archivedAt = (/* @__PURE__ */ new Date()).toISOString();
    task.status = "archived";
    task.settledAt = task.settledAt ?? task.archivedAt;
    task.notify = false;
    task.deliveryReplies = null;
    task.deliveryClaimedFrom = null;
    const controller = this.controllers.get(task.id);
    if (controller !== void 0) {
      this.controllers.delete(task.id);
      try {
        controller.abort(new Error("the conversation was archived"));
      } catch {
      }
    }
    for (const timers of [this.deliveryTimers, this.notifyTimers]) {
      const timer = timers.get(task.id);
      if (timer !== void 0) {
        clearTimeout(timer);
        timers.delete(task.id);
      }
    }
    this.monitors.delete(task.id);
    this.#notifyWaiters(task);
    await this.#save(task);
  }
  /**
   * Remember one delivered message in the task's rolling two-message history.
   * @param {object} task task record.
   * @param {string} text delivered prompt.
   * @returns {void}
   */
  #recordSent(task, text) {
    const message = truncate(String(text ?? ""), 2e3);
    if (message === "") return;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    task.lastPrompt = message;
    task.lastSentAt = at;
    const history = Array.isArray(task.sentMessages) ? task.sentMessages.slice() : [];
    history.push({ text: message, at });
    task.sentMessages = history.slice(-2);
  }
  /** Replies this task received but no `wait` call has returned yet. */
  #pendingReplies(task) {
    const delivered = Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0;
    const replies = Array.isArray(task.replies) ? task.replies : [];
    return replies.filter((reply) => Number.isSafeInteger(reply?.seq) && reply.seq > delivered);
  }
  /**
   * Whether the member's reply counter went backwards.
   *
   * The counter is an in-memory increment per conversation. A member that
   * restarted used to begin a new epoch at zero while the caller still held the
   * old cursor, which made every new reply look "already seen"; older members
   * still do this, so the caller must notice it rather than trust `since`.
   * @param {object} task tracked task.
   * @param {unknown} conversation conversation projection from the member.
   * @returns {boolean} true when a re-sync is needed.
   */
  #replyCursorReset(task, conversation) {
    const seen = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0;
    const reported = Number.isSafeInteger(conversation?.replySeq) ? conversation.replySeq : null;
    return seen > 0 && reported !== null && reported < seen;
  }
  /**
   * Start a new reply epoch at the member's current counter.
   *
   * The stored reply texts belong to the previous epoch, and their seq numbers
   * no longer match the member's; dropping them is what lets the caller accept
   * the replies the member still has.
   * @param {object} task tracked task.
   * @param {number} reported the member's counter.
   * @returns {Promise<void>} resolution after the state is saved.
   */
  async #resetReplyCursor(task, reported) {
    const previous = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0;
    task.replySeq = 0;
    task.deliveredSeq = 0;
    task.replies = [];
    await this.#log(task, `reply cursor reset on the member (was ${String(previous)}, member now reports ${String(reported)}); re-syncing replies`);
    await this.#save(task).catch(() => {
    });
  }
  /**
   * Re-read a finished task's member conversation before answering a wait.
   *
   * The monitor stops at the terminal state, so a turn the member ran
   * afterwards (or a restart that reset its reply counter) never reached the
   * local record. The read decides whether a fetch is needed; only an idle
   * conversation is synced, because a running one is the caller's next send
   * to handle.
   * @param {object} task tracked task.
   * @param {AbortSignal} [signal] cancellation of the waiting tool call.
   * @returns {Promise<void>} resolution after the best-effort sync.
   */
  async #syncTerminal(task, signal) {
    let state;
    try {
      state = await this.#request(
        task.baseUrl,
        "GET",
        `/v1/conversations/${encodeURIComponent(task.conversationId)}`,
        void 0,
        5e3,
        signal
      );
    } catch {
      signal?.throwIfAborted();
      return;
    }
    const conversation = state?.conversation;
    if (conversation === null || typeof conversation !== "object") return;
    this.#rememberWorkspace(task, conversation);
    if (String(conversation.status ?? "") !== "idle") return;
    const reset = this.#replyCursorReset(task, conversation);
    if (reset) await this.#resetReplyCursor(task, conversation.replySeq);
    const cursor = Number.isSafeInteger(task.replySeq) ? task.replySeq : 0;
    const reported = Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0;
    if (!reset && reported <= cursor) return;
    let result;
    try {
      result = await this.#request(
        task.baseUrl,
        "POST",
        `/v1/conversations/${encodeURIComponent(task.conversationId)}/wait`,
        { timeoutMs: 1e3, since: cursor },
        2e4,
        signal
      );
    } catch {
      signal?.throwIfAborted();
      return;
    }
    if (result?.state !== "progress" && result?.state !== "done") return;
    await this.#acceptReplies(task, result, { notify: false }).catch(() => {
    });
    if (Number.isSafeInteger(result.turn)) task.turns = result.turn;
    await this.#save(task).catch(() => {
    });
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
  /**
   * Wake every `wait_member` call parked on this task.
   * @param {object} task member task.
   * @returns {number} how many waiters were woken; the monitor uses this to
   *   give a parked wait its longer terminal-consumption window.
   */
  #notifyWaiters(task) {
    const parked = this.waiters.get(task.id);
    if (parked === void 0) return 0;
    this.waiters.delete(task.id);
    for (const waiter of [...parked]) {
      try {
        waiter();
      } catch {
      }
    }
    return parked.size;
  }
  /**
   * Send one message into an existing member conversation.
   *
   * The conversation is named by the member's conversation id. That id is the
   * portable key: it is what `call_member` / `wait_member` return, it survives a
   * new process on this side, and it lets a model continue a conversation it
   * did not start.
   *
   * Before the message is queued, a conversation whose context occupancy is
   * already above its own `compressPercent` (default
   * {@link DEFAULT_COMPRESS_PERCENT}) is compacted first, so the next turn
   * starts from a shortened context. The threshold is read from the
   * conversation's stored scope.
   *
   * Compaction is impossible while the conversation is running: the member
   * only compacts an idle agent. A running conversation is therefore delivered
   * directly (the message is steered into the turn in progress) instead of
   * failing the call. The same holds when the conversation starts running
   * between the occupancy read and the compaction request: the refusal is
   * treated as "deliver without compressing", not as an error.
   *
   * Passing `identity` / `role` / `scope` merges the conversation's stored
   * scope and prefixes this delivery with a one-line identity note, so a
   * conversation created before the setting existed can complete it in place.
   *
   * @param {{conversationId: string, member?: string, prompt: string, identity?: unknown, role?: unknown, scope?: unknown, agent?: any, signal?: AbortSignal}} request send request.
   * @returns {Promise<object>} the tracked task.
   */
  async send(request) {
    await this.#ensureLoaded();
    const prompt = request.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("prompt is required");
    const scopePatch = normalizeMemberScopePatch({ identity: request.identity, role: request.role, scope: request.scope });
    const hasScopePatch = Object.keys(scopePatch).length > 0;
    const signal = request.signal;
    const { task, fresh, target } = await this.#sendTarget(request);
    const maintenanceTarget = target ?? { name: task.member, ip: task.memberIp };
    const maintenance = await this.#maintenanceFor(maintenanceTarget);
    if (maintenance !== null) throw memberMaintenanceError(maintenanceTarget, maintenance);
    if (task.archived === true) {
      let live = null;
      try {
        const probe = await this.#request(task.baseUrl, "GET", `/v1/conversations/${encodeURIComponent(task.conversationId)}`, void 0, 1e4);
        live = probe?.conversation ?? null;
      } catch {
        live = null;
      }
      if (live?.archived === false) {
        task.archived = false;
        task.archivedAt = null;
        task.status = "completed";
        await this.#save(task);
      } else {
        throw new Error(`\u6210\u5458\u4F1A\u8BDD ${task.conversationId} \u5DF2\u5F52\u6863\uFF0C\u4E0D\u80FD\u7EE7\u7EED\u6295\u9012\uFF1B\u8981\u6062\u590D\u8BF7\u5728\u6210\u5458 Web UI \u53D6\u6D88\u5F52\u6863\u3002`);
      }
    }
    if (hasScopePatch) {
      if (typeof this.service.setMemberScope !== "function") throw new Error("member scopes are not available");
      const saved = await this.service.setMemberScope(task.conversationId, { identity: request.identity, role: request.role, scope: request.scope });
      task.profile = profileFromScope(saved?.scope ?? null, target?.name ?? task.member);
    } else if (typeof this.service.memberScope === "function") {
      const stored = await this.service.memberScope(task.conversationId).catch(() => null);
      if (stored !== null) task.profile = profileFromScope(stored, target?.name ?? task.member);
    }
    const prefix = hasScopePatch ? profilePromptPrefix(task.profile) : "";
    const environment = environmentPrompt(task.egressLine, await this.#tokenPair());
    const body = await this.#deliverableBody(task.baseUrl, prompt, `member-${task.conversationId}`, signal);
    task.messageSpill = body.spill;
    task.lastTaskText = truncate(prompt, 4e3);
    const deliveredPrompt = [prefix, environment, body.text].filter((part) => part !== "").join("\n");
    task.lastCompaction = null;
    task.liveStatus = "";
    await this.#refreshContext(task, signal);
    const threshold = await this.#compressThreshold(task);
    await this.#compactIfCrowded(task, signal, threshold);
    const result = await this.#waitForRuntime(
      () => this.#request(task.baseUrl, "POST", `/v1/conversations/${encodeURIComponent(task.conversationId)}/messages`, { content: deliveredPrompt }, 3e4, signal),
      9e4,
      signal
    );
    this.#recordSent(task, deliveredPrompt);
    if (fresh) {
      this.#adoptPosition(task, result?.conversation);
      task.prompt = truncate(deliveredPrompt, 2e3);
      this.tasks.set(task.id, task);
    }
    this.#rememberContext(task, result?.context ?? result?.conversation?.context);
    this.#rememberWorkspace(task, result?.conversation);
    task.status = "running";
    task.error = null;
    task.interrupted = false;
    task.attempts = 0;
    task.emptyWaits = 0;
    task.terminalDelivered = false;
    task.repliesTakenByWait = false;
    task.deliveryReplies = null;
    task.deliveryClaimedFrom = null;
    task.deliveryFailed = false;
    task.notified = false;
    task.notifiedAt = null;
    task.notifyError = null;
    task.notify = true;
    task.notifyRetries = 0;
    const pendingDelivery = this.deliveryTimers.get(task.id);
    if (pendingDelivery !== void 0) {
      clearTimeout(pendingDelivery);
      this.deliveryTimers.delete(task.id);
    }
    const pendingNotify = this.notifyTimers.get(task.id);
    if (pendingNotify !== void 0) {
      clearTimeout(pendingNotify);
      this.notifyTimers.delete(task.id);
    }
    const receipt = result?.receipt;
    task.lastDelivery = receipt?.delivery === "steer" || receipt?.steered === true ? "steer" : receipt?.delivery === "followup" || receipt?.accepted === true ? "followup" : null;
    if (!this.controllers.has(task.id)) this.controllers.set(task.id, new AbortController());
    await this.#save(task);
    await this.#log(task, `message queued: ${result?.receipt?.messageId ?? "unknown"}${task.lastDelivery === null ? "" : ` (${task.lastDelivery})`}`);
    if (!this.monitors.has(task.id)) {
      const monitor = this.#monitor(task);
      this.monitors.set(task.id, monitor);
      void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {
      });
    }
    return task;
  }
  /**
   * Resolve who a send targets: an existing tracked task, or a conversation on
   * a named member that this initiator will adopt.
   * @param {{conversationId: string, member?: string, prompt: string, agent?: any}} request send request.
   * @returns {Promise<{task: object, fresh: boolean}>} target task.
   */
  async #sendTarget(request) {
    const conversationId = typeof request.conversationId === "string" ? request.conversationId.trim() : "";
    if (conversationId === "") throw new Error("conversationId is required to continue a conversation");
    const tracked = this.#taskOfConversation(conversationId);
    if (tracked !== void 0) {
      const named2 = typeof request.member === "string" ? request.member.trim() : "";
      let target2;
      if (named2 !== "") {
        target2 = await this.#resolveMember(named2);
        if (target2.baseUrl !== tracked.baseUrl) {
          throw new Error(`conversation ${conversationId} belongs to ${tracked.member} (${tracked.baseUrl}), not ${target2.baseUrl}`);
        }
      }
      return { task: tracked, fresh: false, target: target2 };
    }
    const named = typeof request.member === "string" ? request.member.trim() : "";
    if (named === "") {
      throw new Error("send by conversationId needs member: no local task tracks this conversation");
    }
    const target = await this.#resolveMember(named);
    const mesh = await this.#meshFor(target);
    return {
      task: {
        id: `member-${Date.now().toString(36)}-${randomUUID2().slice(0, 8)}`,
        member: target.name,
        memberIp: target.ip,
        baseUrl: target.baseUrl,
        conversationId,
        /** Filled from the member's live projection by the delivery probe. */
        workspace: "unknown",
        prompt: truncate(request.prompt, 2e3),
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
        /** True once a `wait_member` call returned this task's terminal outcome. */
        terminalDelivered: false,
        notify: true,
        notified: false,
        notifiedAt: null,
        notifyError: null,
        originAgentId: String(request.agent?.id ?? ""),
        originSessionId: String(request.agent?.session?.id ?? ""),
        /** Filled when this delivery sets or inherits a member profile. */
        profile: null,
        /** One-line egress report measured when the conversation was adopted. */
        egressLine: mesh.link === true ? formatEgressLine(mesh) : "",
        context: null,
        lastCompaction: null,
        adopted: true
      },
      fresh: true,
      target
    };
  }
  /**
   * Move an adopted task's cursors to the member's current position.
   * @param {object} task adopted task.
   * @param {unknown} conversation the member's conversation projection.
   * @returns {void}
   */
  #adoptPosition(task, conversation) {
    if (conversation === null || typeof conversation !== "object") return;
    const seq = Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0;
    task.replySeq = Math.max(Number.isSafeInteger(task.replySeq) ? task.replySeq : 0, seq);
    task.deliveredSeq = Math.max(Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0, task.replySeq);
    if (Number.isSafeInteger(conversation.turns)) task.turns = conversation.turns;
  }
  /**
   * Record the context occupancy a member reported.
   * @param {object} task member task.
   * @param {unknown} value raw occupancy.
   * @returns {void}
   */
  #rememberContext(task, value) {
    const context = normalizeContext(value);
    if (context !== null) task.context = context;
  }
  /**
   * Refresh the workspace name the member resolved for a conversation.
   *
   * The member owns the mapping between a request and a directory, so its
   * projection wins over the value guessed at creation. An explicit-cwd
   * conversation reports `workspace: ''`; that is "no workspace name", not a
   * reason to forget the directory name already recorded.
   * @param {object} task member task.
   * @param {unknown} conversation the member's conversation projection.
   * @returns {void}
   */
  #rememberWorkspace(task, conversation) {
    const workspace = conversation?.workspace;
    if (typeof workspace === "string" && workspace.trim() !== "") task.workspace = workspace.trim();
    else if (typeof task.workspace !== "string" || task.workspace.trim() === "") task.workspace = "unknown";
  }
  /**
   * Read the compaction threshold stored for one conversation.
   *
   * A conversation created before the setting, or one whose scope was cleared,
   * uses {@link DEFAULT_COMPRESS_PERCENT}. An unreadable store is treated the
   * same way: the delivery still works with the default.
   * @param {object} task member task.
   * @returns {Promise<number>} percentage threshold.
   */
  async #compressThreshold(task) {
    if (typeof this.service?.memberScope !== "function") return DEFAULT_COMPRESS_PERCENT;
    const scope = await this.service.memberScope(task.conversationId).catch(() => null);
    return effectiveCompressPercent(scope);
  }
  /**
   * Compact before delivery when the target conversation is already loaded.
   *
   * The occupancy is re-read from the member first: the cached figure comes
   * from the last wait, and an adopted conversation has none. A member that
   * does not answer the read with a context leaves the cached value alone, so
   * an older member still decides on what the last wait reported. The threshold
   * comes from the conversation's scope (`compressPercent`, default 35%).
   * "超过" is strict: exactly the threshold delivers directly.
   *
   * A conversation that is running right now is not compacted: the member
   * refuses to compact a live agent, and the delivery is meant to steer that
   * turn anyway. The message is queued directly and the next call decides
   * again from the new occupancy.
   * @param {object} task member task.
   * @param {AbortSignal} [signal] cancellation of the sending tool call.
   * @param {number} threshold percentage threshold for this conversation.
   * @returns {Promise<boolean>} whether a compaction was attempted.
   */
  async #compactIfCrowded(task, signal, threshold) {
    const percent = task.context?.percent;
    if (typeof percent !== "number" || percent <= threshold) return false;
    if (task.liveStatus === "running") {
      await this.#log(
        task,
        `conversation is running; delivering without compaction (over ${String(threshold)}%, observed ${String(percent)}%)`
      );
      return false;
    }
    await this.#compact(task, signal, { threshold, percent });
    return true;
  }
  /**
   * Re-read the target conversation's context occupancy before a delivery.
   *
   * `GET /v1/conversations/<id>` is cheap and reports the same projection the
   * wait responses do. A member from an older release returns no context; the
   * cached value then stays in place. The same read also reports whether the
   * conversation is running, which decides whether a pre-delivery compaction
   * is even possible.
   * @param {object} task member task.
   * @param {AbortSignal} [signal] cancellation of the sending tool call.
   * @returns {Promise<void>} resolution after the best-effort read.
   */
  async #refreshContext(task, signal) {
    try {
      const result = await this.#request(
        task.baseUrl,
        "GET",
        `/v1/conversations/${encodeURIComponent(task.conversationId)}?resume=1`,
        void 0,
        15e3,
        signal
      );
      this.#rememberContext(task, result?.context);
      this.#rememberWorkspace(task, result?.conversation);
      if (typeof result?.conversation?.status === "string") task.liveStatus = result.conversation.status;
      if (this.#replyCursorReset(task, result?.conversation)) {
        await this.#resetReplyCursor(task, result.conversation.replySeq);
      }
    } catch (error) {
      signal?.throwIfAborted();
      void error;
    }
  }
  /**
   * Compact a member conversation before delivering into it.
   *
   * The member owns the session, so only it can compact. An older member has
   * no `/compact` endpoint; that is reported as "upgrade the member", not
   * retried as a transient failure.
   * @param {object} task member task.
   * @param {AbortSignal} [signal] cancellation of the sending tool call.
   * @param {{threshold: number, percent: number}} options the conversation's
   *   threshold and the occupancy that crossed it.
   * @returns {Promise<object>} the recorded compaction.
   */
  async #compact(task, signal, options) {
    const threshold = options.threshold;
    const percent = options.percent;
    await this.#log(
      task,
      `compacting context before delivery (over ${String(threshold)}%, observed ${String(percent)}%)`
    );
    let result;
    try {
      result = await this.#waitForRuntime(
        () => this.#request(
          task.baseUrl,
          "POST",
          `/v1/conversations/${encodeURIComponent(task.conversationId)}/compact`,
          {},
          COMPACT_TIMEOUT_MS,
          signal
        ),
        9e4,
        signal
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/conversation not found|conversation_not_found/iu.test(message)) {
        throw new Error(`\u6210\u5458 ${task.member} \u4E0A\u5DF2\u7ECF\u6CA1\u6709\u5BF9\u8BDD ${task.conversationId}\uFF1A${message}`);
      }
      if (/unknown endpoint|not_found|unsupported|compaction_unavailable/iu.test(message)) {
        throw new Error(`\u5BF9\u8BDD ${task.conversationId} \u7684\u4E0A\u4E0B\u6587\u5360\u6BD4 ${String(percent)}% \u5DF2\u8D85\u8FC7\u538B\u7F29\u9608\u503C ${String(threshold)}%\uFF0C\u4F46\u6210\u5458 ${task.member} \u7684 interop \u670D\u52A1\u4E0D\u652F\u6301\u4E0A\u4E0B\u6587\u538B\u7F29\uFF08\u7248\u672C\u8FC7\u65E7\uFF09\uFF1A${message}\u3002\u5148\u5347\u7EA7\u8BE5\u6210\u5458\u518D\u6295\u9012\u3002`);
      }
      if (/busy|already has active work|conversation_busy|409/iu.test(message)) {
        await this.#log(
          task,
          `conversation started running during compaction; delivering without it (over ${String(threshold)}%, observed ${String(percent)}%): ${message}`
        );
        return null;
      }
      throw error;
    }
    task.lastCompaction = {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      forced: true,
      forcedPercent: threshold,
      observedPercent: percent,
      compacted: result?.compacted === true,
      summary: summaryText(result?.summary),
      shadowedCount: Number.isSafeInteger(result?.shadowedCount) ? result.shadowedCount : 0,
      shadowedTokenCount: Number.isSafeInteger(result?.shadowedTokenCount) ? result.shadowedTokenCount : null
    };
    this.#rememberContext(task, result?.context);
    await this.#log(
      task,
      task.lastCompaction.compacted ? `compacted ${String(task.lastCompaction.shadowedCount)} item(s), ~${String(task.lastCompaction.shadowedTokenCount ?? 0)} tokens` : "no compactable history"
    );
    return task.lastCompaction;
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
        task.unreachableSince = null;
        this.#rememberContext(task, result.context ?? result.conversation?.context);
        const conversation = result.conversation ?? {};
        this.#rememberWorkspace(task, conversation);
        if (this.#replyCursorReset(task, conversation)) {
          if (Number.isSafeInteger(conversation.turns)) task.turns = conversation.turns;
          await this.#resetReplyCursor(task, conversation.replySeq);
          continue;
        }
        if (result.timedOut === true) {
          task.status = "running";
          await this.#save(task);
          continue;
        }
        if (this.disposed) break;
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
        const connection = connectionFailureCode(error);
        if (connection !== "" && !Number.isFinite(task.unreachableSince)) task.unreachableSince = Date.now();
        await this.#log(task, `wait failed: ${task.error}${connection === "" ? "" : "\uFF08\u8FDE\u63A5\u5931\u8D25\uFF0C\u7EE7\u7EED\u91CD\u8BD5\uFF09"}`);
        if (LOST_CONVERSATION.test(task.error)) {
          task.status = "failed";
          task.interrupted = true;
          break;
        }
        if (connection !== "") {
          const unreachableFor = Date.now() - (Number.isFinite(task.unreachableSince) ? task.unreachableSince : Date.now());
          if (unreachableFor >= UNREACHABLE_RETRY_MS) {
            task.error = `${task.error}\uFF08\u76EE\u6807\u6210\u5458\u8FDE\u7EED ${String(Math.round(UNREACHABLE_RETRY_MS / 6e4))} \u5206\u949F\u4E0D\u53EF\u8FBE\uFF1A\u4EFB\u52A1\u5DF2\u4E2D\u65AD\uFF0C\u6210\u5458\u6062\u590D\u540E\u7528\u540C\u4E00\u4E2A conversationId \u7EE7\u7EED\uFF0C\u6216\u5148 status_member \u67E5\u770B\uFF09`;
            task.status = "failed";
            task.interrupted = true;
            break;
          }
        } else if (task.attempts >= MAX_ATTEMPTS) {
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
      task.settledAt = (/* @__PURE__ */ new Date()).toISOString();
      await this.#save(task);
      await this.#log(task, `${task.status}: ${truncate(task.lastText || task.error || "", 500)}`);
    }
    const wokenWaiters = this.#notifyWaiters(task);
    if (task.notify && (task.status === "completed" || task.status === "failed")) {
      this.#scheduleDelivery(task, wokenWaiters > 0);
    }
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
    await this.#noteParticipation(task);
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
  /**
   * Cancel a pending fallback delivery for one consumed terminal task.
   *
   * A `wait_member` call that returns the terminal outcome (with or without
   * new text) tells the model the task ended; the fallback timer must not fire
   * afterwards and hand the same answer over a second time.
   * @param {object} task terminal task.
   * @returns {void}
   */
  #consumeTerminal(task) {
    task.terminalDelivered = true;
    const pending = this.deliveryTimers.get(task.id);
    if (pending !== void 0) {
      clearTimeout(pending);
      this.deliveryTimers.delete(task.id);
    }
  }
  /**
   * Hand a finished task's result to the calling conversation after a grace window.
   *
   * A parked `wait_member` is woken before this runs, and the model's next step
   * may still issue one; the window is what lets either of them consume the
   * terminal outcome first. A wait that was parked at completion is given
   * {@link WAIT_DELIVERY_GRACE_MS} because its terminal re-read is slower than
   * one event-loop hop. The timer is unref'd so a pending delivery never holds
   * the process open on its own.
   * @param {object} task terminal task.
   * @param {boolean} [parkedWait] whether a wait was parked when it finished.
   * @returns {void}
   */
  #scheduleDelivery(task, parkedWait = false) {
    if (task.terminalDelivered === true) return;
    const previous = this.deliveryTimers.get(task.id);
    if (previous !== void 0) clearTimeout(previous);
    const graceMs = parkedWait ? Math.max(this.deliveryGraceMs, this.waitDeliveryGraceMs) : this.deliveryGraceMs;
    const timer = setTimeout(() => {
      this.deliveryTimers.delete(task.id);
      void this.#deliverIfUnconsumed(task).catch(() => {
      });
    }, graceMs);
    timer.unref?.();
    this.deliveryTimers.set(task.id, timer);
  }
  /**
   * Deliver a terminal result unless a `wait_member` call already returned it.
   *
   * The fallback only ever sends replies the model has not seen. Two cases are
   * deliberately distinct:
   *
   * - unreported replies (`seq > deliveredSeq`) are claimed here and delivered
   *   as the result; a wait that runs afterwards cannot return the same text;
   * - with nothing unreported and a wait already having taken the reply (or
   *   the terminal outcome), the fallback stays silent; a task that never
   *   produced any text still gets its single state notice.
   *
   * A terminal outcome a wait already consumed cancels the timer, so no
   * fallback runs at all.
   * @param {object} task terminal task.
   * @returns {Promise<void>} resolution after the notification attempt.
   */
  async #deliverIfUnconsumed(task) {
    if (this.disposed) return;
    if (task.status !== "completed" && task.status !== "failed") return;
    let pending = this.#pendingReplies(task);
    if (pending.length === 0 && task.terminalDelivered !== true && (!Array.isArray(task.replies) || task.replies.length === 0) && typeof task.lastText === "string" && task.lastText !== "") {
      const seq = Number.isSafeInteger(task.replySeq) && task.replySeq > 0 ? task.replySeq : 1;
      pending = [{ seq, turn: Number.isSafeInteger(task.turns) ? task.turns : null, text: task.lastText }];
    }
    if (pending.length === 0 && (task.terminalDelivered === true || task.repliesTakenByWait === true)) {
      await this.#log(task, "delivery skipped: a wait_member call already returned the result");
      return;
    }
    if (pending.length === 0) {
      await this.#log(task, "delivery notice: no reply text was produced");
    }
    if (pending.length > 0) {
      task.deliveryClaimedFrom = Number.isSafeInteger(task.deliveredSeq) ? task.deliveredSeq : 0;
      task.deliveredSeq = pending[pending.length - 1].seq;
      task.deliveryReplies = pending;
      await this.#save(task).catch(() => {
      });
      await this.#log(task, `fallback delivers ${String(pending.length)} unread reply(ies)`);
    }
    await this.#notify(task, pending);
  }
  /**
   * Release a fallback's claim after it could not deliver.
   *
   * The claim advanced `deliveredSeq` before its first await. Putting the old
   * cursor back makes those replies unread again, so a later `wait_member`
   * returns the text rather than suppressing it with a delivery note.
   * @param {object} task terminal task.
   * @returns {void}
   */
  #releaseDeliveryClaim(task) {
    if (Number.isSafeInteger(task.deliveryClaimedFrom)) task.deliveredSeq = task.deliveryClaimedFrom;
    task.deliveryClaimedFrom = null;
    task.deliveryReplies = null;
    task.deliveryFailed = true;
  }
  /**
   * Retry a delivery whose origin conversation is not live yet.
   *
   * A plugin restart can finish the notification before the Web client
   * reopens its session. The backoff keeps trying while the user may still be
   * coming back, then leaves the result recorded as a notifyError.
   * @param {object} task terminal task.
   * @returns {void}
   */
  #scheduleNotifyRetry(task) {
    const previous = this.notifyTimers.get(task.id);
    if (previous !== void 0) clearTimeout(previous);
    const retry = Number.isSafeInteger(task.notifyRetries) ? task.notifyRetries : 1;
    const delay2 = Math.min(1e4 * 2 ** (retry - 1), 3e5);
    const timer = setTimeout(() => {
      this.notifyTimers.delete(task.id);
      if (this.disposed || task.notified) return;
      void this.#notify(task).catch(() => {
      });
    }, delay2);
    timer.unref?.();
    this.notifyTimers.set(task.id, timer);
  }
  /**
   * The latest identity/scope stored for one conversation.
   *
   * The scope store wins because `set_member_scope` can change it after the
   * task's profile snapshot was written; the snapshot is the fallback for a
   * member from an older release or an unreadable store.
   * @param {object} task tracked task.
   * @returns {Promise<{name: string|null, identity: string|null, scope: string|null}|null>} profile.
   */
  async #latestProfile(task) {
    let scope = null;
    if (typeof this.service?.memberScope === "function") {
      scope = await this.service.memberScope(task.conversationId).catch(() => null);
    }
    return (scope === null ? null : profileFromScope(scope, task.member)) ?? memberTaskProfile(task);
  }
  /**
   * Write one terminal outcome back into the conversation that delegated.
   * @param {object} task terminal task.
   * @param {object[]} replies unread replies this delivery owns; empty means a
   *   short completion notice because the text was already returned by a wait.
   * @returns {Promise<void>} resolution after the notification attempt.
   */
  async #notify(task, replies = Array.isArray(task.deliveryReplies) ? task.deliveryReplies : []) {
    const agents = typeof this.ctx.get === "function" ? this.ctx.get("agents") : this.ctx.agents;
    const agent = agents?.get?.(task.originAgentId);
    if (agent === void 0 || agent === null) {
      if (replies.length > 0) task.deliveryReplies = replies;
      task.notifyError = "the originating conversation is no longer live";
      task.notifyRetries = Number.isSafeInteger(task.notifyRetries) ? task.notifyRetries : 0;
      if (task.notifyRetries < NOTIFY_RETRY_LIMIT) {
        task.notifyRetries += 1;
        this.#scheduleNotifyRetry(task);
      } else {
        this.#releaseDeliveryClaim(task);
      }
      await this.#save(task);
      await this.#log(task, `notification deferred: origin agent unavailable (retry ${String(task.notifyRetries)})`);
      return;
    }
    const resultText = replies.map((reply) => typeof reply?.text === "string" ? reply.text : "").filter((text2) => text2 !== "").join("\n\n").trim();
    const profile = await this.#latestProfile(task);
    const memberLabel = profile?.identity ?? task.member;
    const identifier = `${task.member} (${task.memberIp}) \u7684\u5BF9\u8BDD ${task.conversationId}`;
    const resultLine = resultText !== "" ? truncate(resultText, 8e3) : typeof task.lastText === "string" && task.lastText !== "" ? "\uFF08\u7ED3\u679C\u5DF2\u7531\u5148\u524D\u7684\u7B49\u5F85\u8FD4\u56DE\uFF0C\u8FD9\u91CC\u4E0D\u518D\u91CD\u590D\u6B63\u6587\u3002\uFF09" : "\uFF08\u6210\u5458\u6CA1\u6709\u8FD4\u56DE\u6587\u672C\u7ED3\u679C\uFF09";
    const text = task.status === "completed" ? [
      "[\u6210\u5458\u4EFB\u52A1\u5B8C\u6210]",
      `\u6210\u5458\uFF1A${memberLabel}`,
      `\u6807\u8BC6\u7B26\uFF1A${identifier}`,
      "",
      resultLine
    ].join("\n") : [
      "[\u6210\u5458\u4EFB\u52A1\u5931\u8D25]",
      `\u6210\u5458\uFF1A${memberLabel}`,
      `\u6807\u8BC6\u7B26\uFF1A${identifier}`,
      `\u9519\u8BEF\uFF1A${task.error ?? "unknown"}`,
      ...resultText !== "" ? ["", "\u4E2D\u65AD\u524D\u7684\u56DE\u590D\uFF1A", truncate(resultText, 8e3)] : [],
      ...task.interrupted === true ? ["", `\u76EE\u6807\u7684 DSH \u91CD\u542F\uFF08\u6216\u8FD0\u884C\u65F6\u9000\u51FA\uFF09\u6253\u65AD\u4E86\u8FD9\u4E00\u8F6E\u3002\u5BF9\u8BDD\u548C\u4E0A\u4E0B\u6587\u8FD8\u5728\uFF1A\u7528 call_member \u5E26 conversationId ${task.conversationId} \u7EE7\u7EED\uFF0C\u6216\u65B0\u5F00\u4E00\u4E2A\u4EFB\u52A1\u3002`] : []
    ].join("\n");
    try {
      const message = {
        id: randomUUID2(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "user" }
      };
      let steered = false;
      if (agent.status === "running" && typeof agent.steer === "function") {
        try {
          agent.steer(message);
          steered = true;
        } catch {
          steered = false;
        }
      }
      if (!steered) agent.followup(message);
      const pending = this.notifyTimers.get(task.id);
      if (pending !== void 0) {
        clearTimeout(pending);
        this.notifyTimers.delete(task.id);
      }
      task.notified = true;
      task.notifiedAt = (/* @__PURE__ */ new Date()).toISOString();
      task.notifiedVia = steered ? "steer" : "followup";
      task.notifyError = null;
      task.notifyRetries = 0;
      task.deliveryReplies = null;
      task.deliveryClaimedFrom = null;
      task.deliveryFailed = false;
      await this.#save(task);
      await this.#log(task, `notification ${steered ? "steered into" : "queued into"} ${task.originSessionId}`);
    } catch (error) {
      task.notifyError = error instanceof Error ? error.message : String(error);
      this.#releaseDeliveryClaim(task);
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
      const text = await readFile17(path25.join(this.taskRoot, `${task.id}.log`), "utf8");
      return text.split("\n").slice(-Math.max(1, Math.min(lines, 500))).join("\n");
    } catch {
      return "";
    }
  }
  /**
   * Absolute path of one task's log file.
   * @param {string} taskId task id.
   * @returns {string} log path.
   */
  logPath(taskId) {
    return path25.join(this.taskRoot, `${String(taskId)}.log`);
  }
};

// src/lib/member-ui.mjs
var MEMBER_UI_TASK_MAX = 2e3;
function memberShortLabel(task) {
  const ip = String(task?.memberIp ?? "").trim();
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(ip);
  if (octets !== null) return octets[4];
  const name = String(task?.member ?? "").trim();
  return name === "" ? "unknown" : name;
}
function memberConversationEntry(task, scopes = {}) {
  const entry = describeMemberTask(task);
  const stored = scopes[String(entry.conversationId ?? "")] ?? null;
  const profile = stored !== null ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task);
  const note = typeof stored?.note === "string" && stored.note.trim() !== "" ? stored.note.trim() : null;
  const compressPercent = typeof stored?.compressPercent === "number" && Number.isFinite(stored.compressPercent) ? stored.compressPercent : null;
  const rawTask = typeof task?.lastTaskText === "string" && task.lastTaskText !== "" ? task.lastTaskText : typeof task?.prompt === "string" && task.prompt !== "" ? task.prompt : typeof task?.lastPrompt === "string" ? task.lastPrompt : "";
  return {
    conversationId: entry.conversationId,
    member: entry.member,
    memberIp: entry.memberIp,
    memberName: profile?.name ?? (entry.member === "" ? null : entry.member),
    memberLabel: memberShortLabel(task),
    workspace: entry.workspace,
    role: profile?.role ?? null,
    identity: profile?.identity ?? null,
    scope: profile?.scope ?? null,
    note,
    compressPercent,
    status: entry.status,
    statusLabel: entry.statusLabel,
    turns: entry.turns,
    createdAt: typeof task?.createdAt === "string" ? task.createdAt : null,
    updatedAt: typeof task?.updatedAt === "string" ? task.updatedAt : null,
    lastSentAt: typeof task?.lastSentAt === "string" ? task.lastSentAt : null,
    lastTask: rawTask.length > MEMBER_UI_TASK_MAX ? `${rawTask.slice(0, MEMBER_UI_TASK_MAX)}\u2026` : rawTask
  };
}
function memberConversationEntries(tasks, scopes = {}) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => task !== null && typeof task === "object").map((task) => memberConversationEntry(task, scopes));
}
function memberConversationSummary(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    total: list.length,
    running: list.filter((entry) => entry?.status === "running" || entry?.status === "starting").length
  };
}

// src/lib/product-stage.mjs
import path26 from "node:path";
var PRODUCT_STAGES = ["A", "B", "C", "D"];
var PRODUCT_STAGE_SHORT = {
  A: "\u8BA1\u5212\u4E0E\u76EE\u6807",
  B: "\u5F00\u53D1\u4E0E\u6D4B\u8BD5",
  C: "\u4EA7\u54C1\u7ECF\u7406\u4F7F\u7528",
  D: "\u4E1A\u52A1\u4ECB\u5165"
};
var PRODUCT_STAGE_REQUIREMENTS = {
  A: "\u6240\u6709\u6210\u5458\u53C2\u4E0E\u5E76\u63D0\u51FA\u5EFA\u8BAE\uFF0C\u6700\u540E\u7531\u4E3B\u5BF9\u8BDD\u51B3\u5B9A\u672C\u8F6E\u8BA1\u5212\u4E0E\u76EE\u6807\u3002",
  B: "\u5F00\u53D1\u3001\u6D4B\u8BD5\u3001\u7814\u7A76\u5458\u3001\u4EA7\u54C1\u7ECF\u7406\u53C2\u4E0E\uFF1B\u672C\u8F6E\u5F00\u53D1\u7684\u529F\u80FD\u6CA1\u6709 BUG\uFF08\u7591\u96BE\u6742\u75C7\u9664\u5916\uFF09\uFF1B\u4EA7\u54C1\u7ECF\u7406\u8C03\u7814\u7ADE\u54C1\u529F\u80FD\u3001\u4E0E\u81EA\u5BB6\u4EA7\u54C1\u5BF9\u6BD4\u5E76\u8F93\u51FA\u62A5\u544A\uFF0C\u4E3A\u4E0B\u4E00\u8F6E A \u9636\u6BB5\u505A\u51C6\u5907\u3002",
  C: "\u4EA7\u54C1\u7ECF\u7406\u771F\u5B9E\u4F7F\u7528\uFF1B\u53D1\u73B0\u95EE\u9898\u56DE\u5230 B \u9636\u6BB5\uFF0C\u76F4\u5230\u4EA7\u54C1\u7ECF\u7406\u653E\u884C\u3002",
  D: "\u4E1A\u52A1\u4EBA\u5458\u5F00\u5C55\u4E1A\u52A1\u5DE5\u4F5C\uFF1B\u53D1\u73B0\u95EE\u9898\u56DE\u5230 C \u9636\u6BB5\uFF0C\u4E1A\u52A1\u653E\u884C\u540E\u56DE\u5230 A \u9636\u6BB5\u5E76\u5347\u4EA7\u54C1\u7248\u672C\u3002"
};
var MEMBER_ROLES = ["\u4EA7\u54C1\u7ECF\u7406", "\u7814\u7A76\u5458", "\u5F00\u53D1", "\u6D4B\u8BD5", "\u4E1A\u52A1"];
var PRODUCT_GOAL_KEYS = ["product", "dev", "research"];
var PRODUCT_GOAL_LABELS = {
  product: "\u4EA7\u54C1\u76EE\u6807",
  dev: "\u5F00\u53D1\u76EE\u6807",
  research: "\u7814\u7A76\u76EE\u6807"
};
var PRODUCT_GOAL_STATUSES = ["\u672A\u5F00\u59CB", "\u8FDB\u884C\u4E2D", "\u5DF2\u8FBE\u6210", "\u672A\u8FBE\u6210"];
var PRODUCT_GOAL_TEXT_MAX = 300;
var PRODUCT_GOAL_CATEGORIES = [
  "\u5E94\u7528\u529F\u80FD",
  "\u5E94\u7528\u754C\u9762",
  "\u5E94\u7528\u670D\u52A1",
  "\u7B97\u6CD5",
  "\u6570\u636E",
  "\u6027\u80FD",
  "\u7A33\u5B9A\u6027",
  "\u5B89\u5168",
  "\u517C\u5BB9\u6027",
  "\u5DE5\u7A0B\u8D28\u91CF",
  "\u4F53\u9A8C",
  "\u4EA4\u4ED8",
  "\u6587\u6863"
];
var PRODUCT_GOAL_CATEGORY_HINT = "\u5E94\u7528\u529F\u80FD / \u5E94\u7528\u754C\u9762 / \u5E94\u7528\u670D\u52A1 / \u7B97\u6CD5 / \u6570\u636E / \u6027\u80FD / \u2026";
var PRODUCT_GOAL_FORMAT = "<\u7C7B\u522B> \u73B0\u72B6 <\u73B0\u5728\u600E\u6837>\uFF0C\u9884\u671F <\u8981\u53D8\u6210\u600E\u6837>\u3002";
var PRODUCT_GOAL_TEXT_PATTERN = /^(.{1,20}?)[\s：:]*现状[\s：:]*(.+?)[，,；;]\s*预期[\s：:]*(.+?)[。.]?$/u;
var PRODUCT_ROUND_MAX = 999;
var PRODUCT_VERSION_PATTERN = /^(\d{8})\.(\d{1,4})(?:\.(\d{1,9}))?$/u;
function productDay(date = /* @__PURE__ */ new Date()) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : /* @__PURE__ */ new Date();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${String(value.getFullYear())}${month}${day}`;
}
function normalizeProductVersion(value) {
  const match = typeof value === "string" ? PRODUCT_VERSION_PATTERN.exec(value.trim()) : null;
  if (match === null) return null;
  const revision = match[3] === void 0 ? "1" : match[3];
  return `${match[1]}.${match[2]}.${revision}`;
}
function nextProductVersion(previous, now = /* @__PURE__ */ new Date()) {
  const day = productDay(now);
  const match = typeof previous === "string" ? PRODUCT_VERSION_PATTERN.exec(previous.trim()) : null;
  if (match === null) return `${day}.1.1`;
  const revision = (match[3] === void 0 ? 1 : Number(match[3])) + 1;
  if (match[1] !== day) return `${day}.1.${String(revision)}`;
  const minor = Number(match[2]) + 1;
  return `${day}.${String(minor)}.${String(revision)}`;
}
function productStageKey(cwd) {
  const text = typeof cwd === "string" ? cwd.trim() : "";
  return text === "" ? "" : path26.resolve(text);
}
function roleOfScope(scope) {
  const role = typeof scope?.role === "string" ? scope.role.trim() : "";
  return MEMBER_ROLES.includes(role) ? role : null;
}
function stageRequiredRoles(stage) {
  if (stage === "A") return [...MEMBER_ROLES];
  if (stage === "B") return ["\u5F00\u53D1", "\u6D4B\u8BD5", "\u7814\u7A76\u5458", "\u4EA7\u54C1\u7ECF\u7406"];
  if (stage === "C") return ["\u4EA7\u54C1\u7ECF\u7406"];
  if (stage === "D") return ["\u4E1A\u52A1"];
  return [];
}
function normalizeGoalText(value, key, category) {
  if (typeof value !== "string") throw new Error(`${key} goal text must be a string`);
  let text = value.trim();
  if (text.length > PRODUCT_GOAL_TEXT_MAX) {
    throw new Error(`${key} goal text is too long: ${String(text.length)} > ${String(PRODUCT_GOAL_TEXT_MAX)} characters`);
  }
  if (text === "") return null;
  if (category !== void 0) {
    const chosen = normalizeGoalCategory(category, key);
    let body = text;
    if (body.startsWith(chosen)) body = body.slice(chosen.length);
    body = body.trim().replace(/^[：:\s]+/u, "");
    if (!/^现状/u.test(body)) {
      throw new Error(`${key} goal text with category must start with \u73B0\u72B6 \u2026\uFF0C\u9884\u671F \u2026\uFF1B\u6536\u5230\uFF1A${text.slice(0, 80)}`);
    }
    text = `${chosen} ${body}`;
  }
  const match = PRODUCT_GOAL_TEXT_PATTERN.exec(text);
  if (match === null) throw goalFormatError(key, text);
  const parsedCategory = match[1].trim().replace(/[\s：:，,。；;]+$/u, "");
  const current = match[2].trim().replace(/[\s，,；;。.]+$/u, "");
  const expected = match[3].trim().replace(/[\s。.]+$/u, "");
  if (parsedCategory === "" || /[，,。；;\n]/u.test(parsedCategory) || current === "" || expected === "") {
    throw goalFormatError(key, text);
  }
  const normalized = `${parsedCategory} \u73B0\u72B6 ${current}\uFF0C\u9884\u671F ${expected}\u3002`;
  if (normalized.length > PRODUCT_GOAL_TEXT_MAX) {
    throw new Error(`${key} goal text is too long after formatting: ${String(normalized.length)} > ${String(PRODUCT_GOAL_TEXT_MAX)} characters`);
  }
  return normalized;
}
function normalizeGoalCategory(value, key) {
  if (typeof value !== "string") throw new Error(`${key} goal category must be a string`);
  const category = value.trim().replace(/[：:，,。；;\s]+$/u, "");
  if (category === "" || category.length > 20 || /[，,。；;\n]/u.test(category)) {
    throw new Error(`${key} goal category must be 1-20 characters without punctuation: ${value.slice(0, 40)}`);
  }
  return category;
}
function goalFormatError(key, text) {
  return new Error(
    `${PRODUCT_GOAL_LABELS[key] ?? key}\u7684 text \u5FC5\u987B\u662F\u300C${PRODUCT_GOAL_FORMAT}\u300D\uFF08\u7C7B\u522B\u5982 ${PRODUCT_GOAL_CATEGORIES.join(" / ")} / \u2026\uFF1B\u4F8B\uFF1A\u5E94\u7528\u529F\u80FD \u73B0\u72B6 \u53EA\u80FD\u505A\u57FA\u7840\u5EFA\u6A21\uFF0C\u9884\u671F \u652F\u6301\u53C2\u6570\u5316\u7279\u5F81\u4E0E\u5386\u53F2\u56DE\u653E\u3002\uFF09\uFF1B\u6536\u5230\uFF1A${text.slice(0, 80)}`
  );
}
function normalizeGoalStatus(value, key) {
  if (typeof value !== "string") throw new Error(`${key} goal status must be a string`);
  const status = value.trim();
  if (status === "") return null;
  if (!PRODUCT_GOAL_STATUSES.includes(status)) {
    throw new Error(`${key} goal status must be one of ${PRODUCT_GOAL_STATUSES.join(", ")}: ${status}`);
  }
  return status;
}
function normalizeGoalPatch(patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("goals must be an object");
  }
  const goals = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PRODUCT_GOAL_KEYS.includes(key)) {
      throw new Error(`unknown goal: ${key} (expected ${PRODUCT_GOAL_KEYS.join(", ")})`);
    }
    if (typeof value === "string") {
      goals[key] = { text: normalizeGoalText(value, key) };
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${key} goal must be a string or an object with text/status`);
    }
    for (const field of Object.keys(value)) {
      if (field !== "text" && field !== "status" && field !== "category") {
        throw new Error(`unknown ${key} goal field: ${field}`);
      }
    }
    if (value.category !== void 0 && value.text === void 0) {
      throw new Error(`${key} goal category must be sent together with text`);
    }
    const entry = {};
    if (value.text !== void 0) entry.text = normalizeGoalText(value.text, key, value.category);
    if (value.status !== void 0) entry.status = normalizeGoalStatus(value.status, key);
    goals[key] = entry;
  }
  return goals;
}
function normalizeProductStageInput(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("product stage input must be an object");
  }
  const normalized = {};
  if (input.stage !== void 0) {
    if (typeof input.stage !== "string") throw new Error("stage must be a string");
    const stage = input.stage.trim().toUpperCase();
    if (!PRODUCT_STAGES.includes(stage)) {
      throw new Error(`stage must be one of ${PRODUCT_STAGES.join(", ")}: ${stage}`);
    }
    normalized.stage = stage;
  }
  if (input.round !== void 0) {
    const round2 = input.round;
    if (!Number.isSafeInteger(round2) || round2 < 1 || round2 > PRODUCT_ROUND_MAX) {
      throw new Error(`round must be an integer between 1 and ${String(PRODUCT_ROUND_MAX)}`);
    }
    normalized.round = round2;
  }
  if (input.goals !== void 0) normalized.goals = normalizeGoalPatch(input.goals);
  if (Object.keys(normalized).length === 0) throw new Error("stage, round, or goals is required");
  return normalized;
}
function mergeGoals(previous, patch) {
  const goals = {};
  for (const key of PRODUCT_GOAL_KEYS) {
    const stored = previous?.[key];
    if (stored === void 0) continue;
    const text = typeof stored?.text === "string" && stored.text !== "" ? stored.text : null;
    const status = PRODUCT_GOAL_STATUSES.includes(stored?.status) ? stored.status : null;
    if (text !== null || status !== null) goals[key] = { text, status };
  }
  if (patch === void 0) return goals;
  for (const key of PRODUCT_GOAL_KEYS) {
    const change = patch[key];
    if (change === void 0) continue;
    const base = goals[key] ?? { text: null, status: null };
    const text = change.text !== void 0 ? change.text : base.text;
    if (text === null) {
      delete goals[key];
      continue;
    }
    const status = (change.status !== void 0 ? change.status : base.status) ?? "\u672A\u5F00\u59CB";
    goals[key] = { text, status };
  }
  return goals;
}
function normalizeStoredProductStage(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const stage = typeof value.stage === "string" ? value.stage.trim().toUpperCase() : "";
  if (!PRODUCT_STAGES.includes(stage)) return null;
  const version = normalizeProductVersion(value.version);
  if (version === null) return null;
  const round2 = Number.isSafeInteger(value.round) && value.round >= 1 && value.round <= PRODUCT_ROUND_MAX ? value.round : null;
  if (round2 === null) return null;
  const goals = mergeGoals(value.goals, void 0);
  const participation = {};
  if (value.participation !== null && typeof value.participation === "object" && !Array.isArray(value.participation)) {
    for (const [conversationId, entry] of Object.entries(value.participation)) {
      const id = conversationId.trim();
      if (id === "" || entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const turn = Number.isSafeInteger(entry.turn) ? entry.turn : null;
      const at = typeof entry.at === "string" ? entry.at : "";
      participation[id] = { turn, at };
    }
  }
  const roundStartedAt = typeof value.roundStartedAt === "string" && value.roundStartedAt !== "" ? value.roundStartedAt : "";
  const audits = value.audits !== null && typeof value.audits === "object" && !Array.isArray(value.audits) && Number.isSafeInteger(value.audits.count) && value.audits.count >= 0 ? {
    count: value.audits.count,
    lastAt: typeof value.audits.lastAt === "string" ? value.audits.lastAt : ""
  } : null;
  return {
    version,
    stage,
    round: round2,
    goals,
    participation,
    ...roundStartedAt === "" ? {} : { roundStartedAt },
    ...audits === null ? {} : { audits },
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : ""
  };
}
function applyProductStage(previous, input, now = /* @__PURE__ */ new Date()) {
  const prev = previous ?? null;
  const stage = input.stage ?? prev?.stage ?? "A";
  const previousVersion = normalizeProductVersion(prev?.version);
  const version = previousVersion === null ? nextProductVersion(null, now) : stage === "A" && prev.stage === "D" ? nextProductVersion(previousVersion, now) : previousVersion;
  const automaticRound = prev === null ? 1 : stage === "A" && prev.stage === "D" ? prev.round + 1 : prev.round;
  const round2 = Math.min(input.round ?? automaticRound, PRODUCT_ROUND_MAX);
  const reset = prev === null || prev.stage !== stage || prev.round !== round2;
  const previousStart = typeof prev?.roundStartedAt === "string" && prev.roundStartedAt !== "" ? prev.roundStartedAt : typeof prev?.updatedAt === "string" ? prev.updatedAt : "";
  const audits = reset ? null : prev?.audits ?? null;
  return {
    version,
    stage,
    round: round2,
    goals: mergeGoals(prev?.goals, input.goals),
    participation: reset ? {} : { ...prev?.participation ?? {} },
    ...audits === null ? {} : { audits: { ...audits } },
    // A goal-only update keeps the round's start: replies collected before it
    // still count, and the participation window cannot move under the caller.
    roundStartedAt: reset || previousStart === "" ? new Date(now).toISOString() : previousStart,
    updatedAt: new Date(now).toISOString(),
    updatedBy: ""
  };
}
function formatProductStageDefinitions() {
  return [
    "[\u4EA7\u54C1\u9636\u6BB5\u5B9A\u4E49] \u4EA7\u54C1\u6309 A \u2192 B \u2192 C \u2192 D \u2192 A \u5FAA\u73AF\uFF1A",
    ...PRODUCT_STAGES.map((stage) => `- ${stage} ${PRODUCT_STAGE_SHORT[stage]}\uFF1A${PRODUCT_STAGE_REQUIREMENTS[stage]}`)
  ];
}
function roundStartedMs(state) {
  return Date.parse(
    typeof state?.roundStartedAt === "string" && state.roundStartedAt !== "" ? state.roundStartedAt : typeof state?.updatedAt === "string" ? state.updatedAt : ""
  );
}
function countCallMemberReplies(state, tasks) {
  const startedAt = roundStartedMs(state);
  if (!Number.isFinite(startedAt)) return 0;
  let count = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const reply of Array.isArray(task?.replies) ? task.replies : []) {
      const at = typeof reply?.at === "string" ? Date.parse(reply.at) : Number.NaN;
      if (Number.isFinite(at) && at >= startedAt) count += 1;
    }
  }
  return count;
}
function callMemberBudgetFor(budgets, stage) {
  const value = budgets?.[stage];
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}
function formatCallMemberBudgetSettings(budgets) {
  const map = budgets !== null && typeof budgets === "object" && !Array.isArray(budgets) ? budgets : {};
  return PRODUCT_STAGES.map((stage) => {
    const value = callMemberBudgetFor(map, stage);
    return `${stage} ${value === null ? "\u9ED8\u8BA4" : String(value)}`;
  }).join(" / ");
}
function defaultCallMemberBudget(state, tasks, scopes = {}) {
  const count = productStageParticipants(state, tasks, scopes).required.length;
  return Math.max(1, count * 2);
}
function formatCallMemberBudget(state, tasks, budgets, scopes = {}) {
  const explicit = callMemberBudgetFor(budgets, state?.stage);
  const budget = explicit ?? defaultCallMemberBudget(state, tasks, scopes);
  const source = explicit === null ? "\u9ED8\u8BA4 = \u53C2\u4E0E\u6210\u5458\u6570 \xD7 2" : "\u5DF2\u8BBE\u7F6E";
  const used = countCallMemberReplies(state, tasks);
  const remaining = Math.max(0, budget - used);
  const lines = [
    `- call_member \u9884\u7B97\uFF08${state.stage} \u9636\u6BB5\uFF09\uFF1A\u672C\u8F6E\u5DF2\u7528 ${String(used)}/${String(budget)}\uFF0C\u5269\u4F59 ${String(remaining)}\uFF08${source}\uFF09`
  ];
  if (remaining > 0) return lines;
  lines.push(
    `[call_member \u9884\u7B97\u7528\u5C3D] ${state.stage} \u9636\u6BB5\u672C\u8F6E\u9884\u7B97 ${String(budget)} \u6B21\u5DF2\u7528\u5B8C\uFF08\u5DF2\u6709 ${String(used)} \u6761\u6210\u5458\u56DE\u590D\u8FD4\u56DE\u4E3B\u5BF9\u8BDD\uFF09\u3002\u4E0D\u8981\u518D\u6D3E\u65B0\u4EFB\u52A1\uFF1A\u5FC5\u987B\u8FDB\u5165\u4E0B\u4E00\u4E2A\u9636\u6BB5\uFF0C\u5E76\u7528 set_product_stage \u53CA\u65F6\u66F4\u65B0\u9636\u6BB5\u548C\u76EE\u6807\u72B6\u6001\uFF1B\u672C\u8F6E\u53C2\u4E0E\u672A\u9F50\u65F6\uFF0C\u5148 wait_member \u53D6\u56DE\u5DF2\u6D3E\u4EFB\u52A1\u7684\u56DE\u590D\u3002`
  );
  return lines;
}
function goalLine(goal) {
  const text = typeof goal?.text === "string" && goal.text !== "" ? goal.text : "";
  if (text === "") return "\u672A\u8BBE\u7F6E";
  const status = PRODUCT_GOAL_STATUSES.includes(goal?.status) ? goal.status : "\u672A\u5F00\u59CB";
  return `${text}\uFF08${status}\uFF09`;
}
function participantStatus(task) {
  if (typeof task?.statusLabel === "string" && task.statusLabel !== "") return task.statusLabel;
  const status = typeof task?.status === "string" ? task.status : "";
  if (status === "running" || status === "starting") return "\u8FDB\u884C\u4E2D";
  if (status === "completed") return "\u7A7A\u95F2";
  if (status === "failed" || status === "interrupted") return "\u5F02\u5E38\u4E2D\u6B62";
  return status === "" ? "\u672A\u77E5" : status;
}
function latestReplyAt(task) {
  let latest = 0;
  for (const reply of Array.isArray(task?.replies) ? task.replies : []) {
    const at = typeof reply?.at === "string" ? Date.parse(reply.at) : Number.NaN;
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}
function productStageParticipants(state, tasks, scopes = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const startedAt = roundStartedMs(state);
  const entries = list.map((task) => {
    const conversationId = String(task?.conversationId ?? "");
    const stored = scopes[conversationId] ?? null;
    const role = roleOfScope(stored) ?? roleOfScope(task?.profile);
    const replyAt = latestReplyAt(task);
    return {
      conversationId,
      role,
      identity: typeof stored?.identity === "string" && stored.identity !== "" ? stored.identity : typeof task?.profile?.identity === "string" ? task.profile.identity : null,
      statusLabel: participantStatus(task),
      failed: task?.status === "failed" || task?.status === "interrupted",
      participated: Boolean(state?.participation?.[conversationId]) || Number.isFinite(startedAt) && replyAt >= startedAt
    };
  });
  const requiredRoles = stageRequiredRoles(state?.stage);
  const required = state?.stage === "A" ? entries : entries.filter((entry) => entry.role !== null && requiredRoles.includes(entry.role));
  const missing = required.filter((entry) => !entry.participated);
  const missingRoles = state?.stage === "A" ? [] : requiredRoles.filter((role) => !entries.some((entry) => entry.role === role));
  const roleLess = entries.filter((entry) => entry.role === null);
  return { entries, required, missing, missingRoles, roleLess };
}
function participantLabel(entry) {
  return entry.role === null ? entry.conversationId : `${entry.role} ${entry.conversationId}`;
}
function formatProductStageParticipation(state, tasks, scopes = {}, options = {}) {
  const withStatuses = options.statuses !== false;
  const view = productStageParticipants(state, tasks, scopes);
  const done = view.required.filter((entry) => entry.participated);
  const missingLabel = (entry) => `${participantLabel(entry)}${withStatuses ? `\uFF08${entry.statusLabel}${entry.failed ? "\uFF0C\u9700\u5148\u6062\u590D\u4F1A\u8BDD" : ""}\uFF09` : ""}`;
  const lines = [
    `- \u672C\u8F6E\u53C2\u4E0E\uFF1A${String(done.length)}/${String(view.required.length)}${done.length === 0 ? "" : `\uFF08${done.map(participantLabel).join("\uFF1B")}\uFF09`}`
  ];
  if (view.missing.length > 0) {
    lines.push(`- \u672A\u53C2\u4E0E\uFF1A${view.missing.map(missingLabel).join("\u3001")}`);
  }
  if (view.missing.length > 0 || view.missingRoles.length > 0) {
    lines.push("- \u672C\u8F6E\u53C2\u4E0E\u672A\u9F50\uFF1A\u5148\u7ED9\u672A\u53C2\u4E0E\u6210\u5458\u6D3E\u4EFB\u52A1\uFF08call_member\uFF09\uFF0C\u6536\u5230\u56DE\u590D\u540E\u518D\u6362\u9636\u6BB5\uFF1B\u73B0\u5728\u6362\u9636\u6BB5\u6216\u5F00\u65B0\u4E00\u8F6E\u4F1A\u88AB\u62D2\u7EDD\u3002");
  }
  if (view.missingRoles.length > 0) {
    lines.push(`- \u6CA1\u6709\u6210\u5458\u4F1A\u8BDD\u7684\u6807\u51C6\u8EAB\u4EFD\uFF1A${view.missingRoles.join("\u3001")}`);
  }
  if (view.roleLess.length > 0) {
    lines.push(`- \u6807\u51C6\u8EAB\u4EFD\u672A\u8BBE\u7F6E\uFF1A${view.roleLess.map((entry) => `${entry.conversationId}\uFF08${entry.identity ?? "\u8EAB\u4EFD\u672A\u8BBE\u7F6E"}\uFF09`).join("\u3001")}\uFF1B\u7528 set_member_scope { "conversationId": "<\u4F1A\u8BDDid>", "role": "\u5F00\u53D1" } \u8BBE\u7F6E\u3002`);
  }
  return lines;
}
function productStageMoves(stage, round2) {
  if (stage === "A") {
    return [
      { when: "\u6240\u6709\u6210\u5458\u5DF2\u53C2\u4E0E\u5EFA\u8BAE\u3001\u672C\u8F6E\u8BA1\u5212\u4E0E\u76EE\u6807\u5DF2\u7ECF\u786E\u5B9A", call: '{ "stage": "B" }' },
      { when: "\u8BA1\u5212\u8FD8\u9700\u8981\u5728\u540C\u4E00\u9636\u6BB5\u7EE7\u7EED\u8BA8\u8BBA\u6216\u8865\u5145", call: `{ "round": ${String(round2)} }` },
      { when: "\u53EA\u9700\u8981\u66F4\u65B0\u4EA7\u54C1\u76EE\u6807\u6216\u72B6\u6001", call: '{ "goals": { "product": { "status": "\u8FDB\u884C\u4E2D" } } }' }
    ];
  }
  if (stage === "B") {
    return [
      { when: "\u672C\u8F6E\u529F\u80FD\u5DF2\u7ECF\u6CA1\u6709 BUG\uFF08\u7591\u96BE\u6742\u75C7\u9664\u5916\uFF09\uFF0C\u53EF\u4EE5\u4EA4\u7ED9\u4EA7\u54C1\u7ECF\u7406\u4F7F\u7528", call: '{ "stage": "C" }' },
      { when: "\u53D1\u73B0\u95EE\u9898\u9700\u8981\u56DE\u5230\u8BA1\u5212\u91CD\u65B0\u5B9A\u76EE\u6807", call: '{ "stage": "A" }' },
      { when: "\u672C\u8F6E\u8FD8\u9700\u8981\u7EE7\u7EED\u4FEE\u590D\u6216\u9A8C\u8BC1", call: `{ "round": ${String(round2)} }` },
      { when: "\u53EA\u9700\u8981\u66F4\u65B0\u5F00\u53D1\u76EE\u6807\u72B6\u6001", call: '{ "goals": { "dev": { "status": "\u5DF2\u8FBE\u6210" } } }' }
    ];
  }
  if (stage === "C") {
    return [
      { when: "\u4EA7\u54C1\u7ECF\u7406\u771F\u5B9E\u4F7F\u7528\u540E\u653E\u884C", call: '{ "stage": "D" }' },
      { when: "\u4EA7\u54C1\u7ECF\u7406\u53D1\u73B0\u95EE\u9898\u9700\u8981\u4FEE\u590D", call: '{ "stage": "B" }' },
      { when: "\u9A8C\u6536\u8FD8\u9700\u8981\u591A\u8F6E", call: `{ "round": ${String(round2)} }` },
      { when: "\u53EA\u9700\u8981\u66F4\u65B0\u4EA7\u54C1\u76EE\u6807\u72B6\u6001", call: '{ "goals": { "product": { "status": "\u5DF2\u8FBE\u6210" } } }' }
    ];
  }
  if (stage === "D") {
    return [
      { when: "\u4E1A\u52A1\u4EBA\u5458\u653E\u884C\u3001\u5F00\u542F\u4E0B\u4E00\u8F6E\uFF08\u4EA7\u54C1\u7248\u672C\u81EA\u52A8\u5347\u7EA7\uFF09", call: '{ "stage": "A" }' },
      { when: "\u4E1A\u52A1\u53D1\u73B0\u95EE\u9898\u9700\u8981\u4EA7\u54C1\u7ECF\u7406\u786E\u8BA4", call: '{ "stage": "C" }' },
      { when: "\u4E1A\u52A1\u9A8C\u8BC1\u8FD8\u9700\u8981\u591A\u8F6E", call: `{ "round": ${String(round2)} }` },
      { when: "\u53EA\u9700\u8981\u66F4\u65B0\u76EE\u6807\u72B6\u6001", call: '{ "goals": { "product": { "status": "\u5DF2\u8FBE\u6210" } } }' }
    ];
  }
  return [];
}
function formatProductStageNextMoves(state) {
  const current = Number.isSafeInteger(state?.round) ? state.round : 1;
  const round2 = Math.min(current + 1, PRODUCT_ROUND_MAX);
  const moves = productStageMoves(state?.stage, round2);
  return [
    "\u540E\u7EED\u53EF\u80FD\u8D70\u5411\uFF1A",
    ...moves.map((move, index) => `${String(index + 1)}. \u5982\u679C${move.when}\uFF0C\u5219 set_product_stage(${move.call})`)
  ];
}
function formatProductStageLines(state, tasks, scopes = {}, options = {}) {
  return [
    `[\u4EA7\u54C1\u9636\u6BB5] ${state.version} \xB7 ${state.stage} \u9636\u6BB5\uFF08\u7B2C ${String(state.round)} \u8F6E\u8FED\u4EE3\uFF09\xB7 ${PRODUCT_STAGE_SHORT[state.stage] ?? ""}`,
    ...formatCallMemberBudget(state, tasks, options.callMemberBudget, scopes),
    `- \u9636\u6BB5\u8981\u6C42\uFF1A${PRODUCT_STAGE_REQUIREMENTS[state.stage] ?? ""}`,
    ...PRODUCT_GOAL_KEYS.map((key) => `- ${PRODUCT_GOAL_LABELS[key]}\uFF1A${goalLine(state.goals?.[key])}`),
    `- \u76EE\u6807\u6587\u672C\u683C\u5F0F\uFF1A${PRODUCT_GOAL_FORMAT}\uFF08\u7C7B\u522B\u5982 ${PRODUCT_GOAL_CATEGORY_HINT}\uFF09`,
    ...formatProductStageParticipation(state, tasks, scopes, { statuses: options.statuses }),
    ...formatProductStageNextMoves(state)
  ];
}
function productStageParticipationBlockers(state, tasks, scopes = {}) {
  const view = productStageParticipants(state, tasks, scopes);
  const lines = [];
  for (const entry of view.missing) {
    lines.push(`${participantLabel(entry)} \u8FD8\u6CA1\u6709\u53C2\u4E0E\u672C\u8F6E\uFF08${entry.statusLabel}${entry.failed ? "\uFF0C\u9700\u5148\u6062\u590D\u4F1A\u8BDD" : ""}\uFF09`);
  }
  for (const role of view.missingRoles) {
    lines.push(`\u6CA1\u6709${role}\u8EAB\u4EFD\u7684\u6210\u5458\u4F1A\u8BDD`);
  }
  return lines;
}
function isAdvancingProductStage(previous, next) {
  if (previous === null || previous === void 0 || next === null || next === void 0) return false;
  if (previous.stage === next.stage) return next.round !== previous.round;
  const order = { A: 0, B: 1, C: 2, D: 3 };
  const from = order[previous.stage];
  const to = order[next.stage];
  if (from === void 0 || to === void 0) return false;
  return to > from || previous.stage === "D" && next.stage === "A";
}
function formatProductStageBlocked(previous, next, blockers) {
  return [
    `\u65E0\u6CD5\u8FDB\u5165 ${next.stage} \u9636\u6BB5\uFF08\u7B2C ${String(next.round)} \u8F6E\u8FED\u4EE3\uFF09\uFF1A\u672C\u8F6E\u53C2\u4E0E\u4EBA\u5458\u4E0D\u6EE1\u8DB3\u8981\u6C42\uFF0C\u9636\u6BB5\u72B6\u6001\u6CA1\u6709\u6539\u53D8\u3002`,
    `- \u5F53\u524D\uFF1A${previous.version} \xB7 ${previous.stage} \u9636\u6BB5\uFF08\u7B2C ${String(previous.round)} \u8F6E\u8FED\u4EE3\uFF09`,
    "\u53C2\u4E0E\u68C0\u67E5\uFF1A",
    ...blockers.map((line) => `- ${line}`),
    "\u5148\u8BA9\u8FD9\u4E9B\u6210\u5458\u5728\u672C\u8F6E\u56DE\u590D\uFF08call_member \u6D3E\u4EFB\u52A1\u3001wait_member \u53D6\u56DE\u590D\uFF09\uFF0C\u518D\u91CD\u8BD5 set_product_stage\u3002"
  ].join("\n");
}
function formatProductStageResult(state, options = {}) {
  const lines = [
    `${options.created === true ? "\u4EA7\u54C1\u9636\u6BB5\u5DF2\u5EFA\u7ACB" : "\u4EA7\u54C1\u9636\u6BB5\u5DF2\u66F4\u65B0"}\uFF1A${state.version} \xB7 ${state.stage} \u9636\u6BB5\uFF08\u7B2C ${String(state.round)} \u8F6E\u8FED\u4EE3\uFF09`,
    `- \u9636\u6BB5\u8981\u6C42\uFF1A${PRODUCT_STAGE_REQUIREMENTS[state.stage] ?? ""}`,
    ...PRODUCT_GOAL_KEYS.map((key) => `- ${PRODUCT_GOAL_LABELS[key]}\uFF1A${goalLine(state.goals?.[key])}`),
    ...formatProductStageParticipation(state, options.tasks ?? [], options.scopes ?? {}),
    ...formatProductStageNextMoves(state),
    ...Array.isArray(options.warnings) && options.warnings.length > 0 ? ["[\u653E\u884C\u68C0\u67E5]", ...options.warnings.map((line) => `- ${line}`)] : []
  ];
  return lines.join("\n");
}
function productStageWarnings(previous, tasks, scopes = {}) {
  if (previous === null || previous === void 0) return [];
  const view = productStageParticipants(previous, tasks, scopes);
  const warnings = [];
  if (view.missing.length > 0) {
    warnings.push(`\u79BB\u5F00 ${previous.stage} \u9636\u6BB5\u65F6\u8FD8\u6709\u6210\u5458\u6CA1\u6709\u53C2\u4E0E\u672C\u8F6E\uFF1A${view.missing.map(participantLabel).join("\u3001")}`);
  }
  if (view.missingRoles.length > 0) {
    warnings.push(`\u79BB\u5F00 ${previous.stage} \u9636\u6BB5\u65F6\u6CA1\u6709\u8FD9\u4E9B\u8EAB\u4EFD\u7684\u6210\u5458\u4F1A\u8BDD\uFF1A${view.missingRoles.join("\u3001")}`);
  }
  if (view.roleLess.length > 0) {
    warnings.push(`\u79BB\u5F00 ${previous.stage} \u9636\u6BB5\u65F6\u4ECD\u6709\u6210\u5458\u6CA1\u6709\u8BBE\u7F6E\u6807\u51C6\u8EAB\u4EFD\uFF1A${view.roleLess.map((entry) => entry.conversationId).join("\u3001")}`);
  }
  if (previous.stage === "A" && !previous.goals?.product?.text) {
    warnings.push("\u79BB\u5F00 A \u9636\u6BB5\u65F6\u4EA7\u54C1\u76EE\u6807\u8FD8\u6CA1\u6709\u8BBE\u7F6E");
  }
  if (previous.stage === "B" && previous.goals?.dev?.status !== "\u5DF2\u8FBE\u6210") {
    warnings.push("\u79BB\u5F00 B \u9636\u6BB5\u65F6\u5F00\u53D1\u76EE\u6807\u72B6\u6001\u4E0D\u662F\u300C\u5DF2\u8FBE\u6210\u300D");
  }
  if (previous.stage === "C" && previous.goals?.product?.status !== "\u5DF2\u8FBE\u6210") {
    warnings.push("\u79BB\u5F00 C \u9636\u6BB5\u65F6\u4EA7\u54C1\u76EE\u6807\u72B6\u6001\u4E0D\u662F\u300C\u5DF2\u8FBE\u6210\u300D");
  }
  return warnings;
}

// src/lib/service.mjs
var HERE2 = path27.dirname(fileURLToPath2(import.meta.url));
var execFileAsync2 = promisify3(execFile3);
var PROBE_GRACE_MS = 10 * 6e4;
var PROBE_TIMEOUT_MS = 4500;
var PROBE_RETRY_MS = 4500;
var PROBE_CACHE_TTL_MS = 7 * 24 * 60 * 6e4;
var MEMBER_IDENTITY_MAX = 40;
var MEMBER_SCOPE_MAX = 120;
var UPGRADE_ANNOUNCE_WINDOW_MS = UPGRADE_LEAD_MS * 3;
var UPGRADE_PREPARE_GRACE_MS = 5 * 6e4;
var DEFAULT_COMPRESS_PERCENT = 35;
var MEMBER_NOTE_MAX = 500;
var MEMBER_KEEP_PROMPT_MAX = 200;
var MEMBER_CALL_BUDGET_MAX = 999;
var BUDGET_AUDIT_MAX = 3;
var BUDGET_AUDIT_INTERVAL_MS = 10 * 6e4;
function normalizeCallMemberBudgets(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("callMemberBudget must be an object mapping A, B, C, D to budgets (no single number)");
  }
  const keys = Object.keys(value);
  if (keys.length === 0) throw new Error("callMemberBudget must set at least one of A, B, C, D");
  for (const key of keys) {
    if (!PRODUCT_STAGES.includes(key)) throw new Error(`unknown callMemberBudget stage: ${key}`);
  }
  const budgets = {};
  for (const stage of PRODUCT_STAGES) {
    const budget = value[stage];
    if (budget === void 0) continue;
    if (!Number.isSafeInteger(budget)) throw new Error(`callMemberBudget.${stage} must be an integer`);
    if (budget < 1 || budget > MEMBER_CALL_BUDGET_MAX) {
      throw new Error(`callMemberBudget.${stage} is out of range: ${String(budget)} (1-${String(MEMBER_CALL_BUDGET_MAX)})`);
    }
    budgets[stage] = budget;
  }
  return budgets;
}
function normalizeMemberScopePatch(patch = {}) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("member scope must be an object");
  }
  const normalized = {};
  if (patch.identity !== void 0) {
    if (typeof patch.identity !== "string") throw new Error("identity must be a string");
    const text = patch.identity.trim();
    if (text.length > MEMBER_IDENTITY_MAX) {
      throw new Error(`identity is too long: ${String(text.length)} > ${String(MEMBER_IDENTITY_MAX)} characters`);
    }
    normalized.identity = text === "" ? null : text;
  }
  if (patch.role !== void 0) {
    if (typeof patch.role !== "string") throw new Error("role must be a string");
    const role = patch.role.trim();
    if (role !== "" && !MEMBER_ROLES.includes(role)) {
      throw new Error(`role must be one of ${MEMBER_ROLES.join(", ")}: ${role}`);
    }
    normalized.role = role === "" ? null : role;
  }
  if (patch.scope !== void 0) {
    if (typeof patch.scope !== "string") throw new Error("scope must be a string");
    const text = patch.scope.trim();
    if (text.length > MEMBER_SCOPE_MAX) {
      throw new Error(`scope is too long: ${String(text.length)} > ${String(MEMBER_SCOPE_MAX)} characters`);
    }
    normalized.scope = text === "" ? null : text;
  }
  if (patch.note !== void 0) {
    if (typeof patch.note !== "string") throw new Error("note must be a string");
    const text = patch.note.trim();
    if (text.length > MEMBER_NOTE_MAX) {
      throw new Error(`note is too long: ${String(text.length)} > ${String(MEMBER_NOTE_MAX)} characters`);
    }
    normalized.note = text === "" ? null : text;
  }
  if (patch.keep !== void 0) {
    if (typeof patch.keep !== "boolean") throw new Error("keep must be a boolean");
    normalized.keep = patch.keep;
  }
  if (patch.keepPrompt !== void 0) {
    if (typeof patch.keepPrompt !== "string") throw new Error("keepPrompt must be a string");
    const text = patch.keepPrompt.trim();
    if (text.length > MEMBER_KEEP_PROMPT_MAX) {
      throw new Error(`keepPrompt is too long: ${String(text.length)} > ${String(MEMBER_KEEP_PROMPT_MAX)} characters`);
    }
    normalized.keepPrompt = text === "" ? null : text;
  }
  if (patch.avoidLongJobs !== void 0) {
    if (typeof patch.avoidLongJobs !== "boolean") throw new Error("avoidLongJobs must be a boolean");
    normalized.avoidLongJobs = patch.avoidLongJobs;
  }
  if (patch.budgetAudit !== void 0) {
    if (typeof patch.budgetAudit !== "boolean") throw new Error("budgetAudit must be a boolean");
    normalized.budgetAudit = patch.budgetAudit;
  }
  if (patch.waitMember !== void 0) {
    if (typeof patch.waitMember !== "boolean") throw new Error("waitMember must be a boolean");
    normalized.waitMember = patch.waitMember;
  }
  if (patch.compressOnTurnEnd !== void 0) {
    if (typeof patch.compressOnTurnEnd !== "boolean") throw new Error("compressOnTurnEnd must be a boolean");
    normalized.compressOnTurnEnd = patch.compressOnTurnEnd;
  }
  if (patch.callMemberBudget !== void 0) {
    normalized.callMemberBudget = normalizeCallMemberBudgets(patch.callMemberBudget);
  }
  if (patch.compressPercent !== void 0) {
    const value = patch.compressPercent;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("compressPercent must be a number");
    }
    if (value < 1 || value > 100) {
      throw new Error(`compressPercent is out of range: ${String(value)} (1-100)`);
    }
    normalized.compressPercent = value;
  }
  return normalized;
}
function effectiveCompressPercent(scope) {
  const value = scope?.compressPercent;
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 100 ? value : DEFAULT_COMPRESS_PERCENT;
}
function savedScopeText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || text.length > max ? null : text;
}
function savedScopeNumber(value, valid) {
  return typeof value === "number" && Number.isFinite(value) && valid(value) ? value : void 0;
}
function savedCallMemberBudgets(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const budgets = {};
  for (const stage of PRODUCT_STAGES) {
    const budget = value[stage];
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > MEMBER_CALL_BUDGET_MAX) continue;
    budgets[stage] = budget;
  }
  return Object.keys(budgets).length > 0 ? budgets : void 0;
}
function findRepositoryRoot(start) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync14(path27.join(current, "build", "recipes.json")) && existsSync14(path27.join(current, "code", "build"))) {
      return current;
    }
    const parent = path27.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path27.resolve(start, "..", "..");
}
var REPOSITORY_ROOT = findRepositoryRoot(HERE2);
function runSshProbe(args, source, timeoutMs = 3e4) {
  return new Promise((resolve) => {
    const child = spawn7("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "probe timed out" }), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    child.once("close", () => {
      const line = String(stdout).trim().split(/\r?\n/u).filter(Boolean).pop() ?? "";
      try {
        const parsed = JSON.parse(line);
        finish(parsed !== null && typeof parsed === "object" ? parsed : { ok: false, error: "probe returned no object" });
      } catch {
        finish({ ok: false, error: (String(stderr).trim() || "no probe output").slice(0, 160) });
      }
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(source);
  });
}
function packageVersion() {
  try {
    const parsed = JSON.parse(readFileSync5(path27.join(REPOSITORY_ROOT, "package.json"), "utf8"));
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
    this.jobRoot = path27.join(this.dataDir, "build");
    this.cacheDir = path27.join(this.dataDir, "cache");
    this.version = packageVersion();
    this.repositoryRoot = REPOSITORY_ROOT;
    this.recipesPath = path27.join(REPOSITORY_ROOT, "build", "recipes.json");
    this.overlayRoot = path27.join(REPOSITORY_ROOT, "build", "overlays");
    this.home = path27.dirname(this.dataDir);
    this.deployRoot = path27.join(this.dataDir, "deploy");
    this.memberTagsFile = path27.join(this.dataDir, "member-tags.json");
    this.memberScopesFile = path27.join(this.dataDir, "member-scopes.json");
    this.productStagesFile = path27.join(this.dataDir, "product-stages.json");
    this.productStageWrites = Promise.resolve();
    this.announcedUpgrades = /* @__PURE__ */ new Map();
    this.packagesDir = path27.join(os10.homedir(), ".dsh", "packages");
    this.releaseConfigFile = path27.join(this.dataDir, "release.json");
    this.latestReleaseCache = null;
    const geoConfig = this.config.geo === false ? { enabled: false } : this.config.geo !== null && typeof this.config.geo === "object" ? this.config.geo : {};
    this.geo = options.geoLookup ?? new GeoLookup({
      enabled: geoConfig.enabled !== false,
      cacheFile: path27.join(this.dataDir, "geo-cache.json"),
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
    this.probeCacheFile = path27.join(this.dataDir, "probe-cache.json");
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
      const parsed = JSON.parse(await readFile18(this.probeCacheFile, "utf8"));
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
      await mkdir15(path27.dirname(this.probeCacheFile), { recursive: true });
      await writeFile15(this.probeCacheFile, JSON.stringify(Object.fromEntries(this.probes)), "utf8");
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
    const stateFile = path27.join(this.home, "wireguard", "state.json");
    const { state, error } = await readWireGuardState({ file: stateFile });
    const identity = state === null ? null : wireGuardIdentity(state);
    return {
      ok: true,
      host: {
        hostname: os10.hostname(),
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
        // Panel defaults: pull-back is opt-in, the post-build upgrade is on.
        pullBack: pullBackEnabled(void 0, this.config),
        autoUpgrade: autoUpgradeEnabled(void 0, this.config),
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
    const path33 = "/__gate/cluster/__gate/session/promote";
    const response = await fetch(`http://${host}${path33}`, {
      method: "POST",
      headers: { [CLUSTER_HEADER]: signClusterRequest(deriveClusterSecret(password), { method: "POST", path: path33 }) }
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
  async members() {
    await this.#loadProbes();
    const stateFile = path27.join(this.home, "wireguard", "state.json");
    const { state, error } = await readWireGuardState({ file: stateFile });
    const identity = state === null ? null : wireGuardIdentity(state);
    const self = {
      id: "local",
      kind: "self",
      name: identity?.selfName ?? os10.hostname(),
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
   * The direct link the mesh networking config gives one member, if any.
   *
   * Only the link's client has a local proxy: the server side supplies the
   * egress. A member without a client link gets no proxy information at all —
   * there is nothing configured to report, and nothing to set up.
   * @param {string} ip member VPN address.
   * @returns {Promise<{proxy: string, port: number}|null>} proxy facts, or null.
   */
  async directLinkFor(ip) {
    const address = String(ip ?? "").trim();
    if (address === "") return null;
    const links = await this.#directLinks();
    const link3 = links.find((item) => item !== null && typeof item === "object" && item?.client?.ip === address);
    if (link3 === void 0) return null;
    const proxy2 = typeof link3.httpProxy === "string" ? link3.httpProxy.trim() : "";
    if (proxy2 === "") return null;
    try {
      const url = new URL(proxy2);
      const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
      return Number.isInteger(port) && port > 0 && port < 65536 ? { proxy: proxy2, port } : null;
    } catch {
      return null;
    }
  }
  /**
   * SSH into one member and measure its local proxy egress.
   *
   * The probe is the shipped ES module (`egress-probe.mjs`), piped into the
   * target's own Node over the mesh SSH key: the measurement runs on the
   * machine that will use the proxy, through the same loopback listeners the
   * agent would use. The result is a one-line report for `call_member`.
   * @param {string} ip member VPN address.
   * @param {number} port HTTP proxy port the mesh networking config advertises.
   * @returns {Promise<{ok: boolean, port?: number, latencyMs?: number, downMbps?: number|null, error?: string}>} probe result.
   */
  async probeMemberEgress(ip, port) {
    const address = String(ip ?? "").trim();
    if (address === "") return { ok: false, error: "member address is empty" };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "proxy port is invalid" };
    const { state } = await readWireGuardState({ file: path27.join(this.home, "wireguard", "state.json") });
    const peer = state?.server?.peers?.find((candidate) => candidate?.ip === address);
    if (peer === void 0 || peer === null) return { ok: false, error: "member is not in the WireGuard state" };
    const digest = createHash8("sha256").update(String(peer.publicKey ?? "")).digest("hex");
    const key = path27.join(this.home, "wireguard", "ssh", `${digest}.key`);
    if (!existsSync14(key)) return { ok: false, error: "no SSH key for this member" };
    const windows = String(peer.platform ?? "").toLowerCase().startsWith("win");
    const remote = windows ? `"%USERPROFILE%\\.dsh\\runtime\\node\\node.exe" --input-type=module - ${String(port)}` : `~/.dsh/runtime/node/bin/node --input-type=module - ${String(port)}`;
    const user = typeof peer.sshUser === "string" && peer.sshUser !== "" ? peer.sshUser : "root";
    return await runSshProbe([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-i",
      key,
      `${user}@${address}`,
      remote
    ], EGRESS_PROBE_SOURCE);
  }
  /**
   * The git tokens the mesh's package management holds, for the injected
   * context of a member conversation.
   * @returns {Promise<{github: string|null, gitee: string|null}>} token values.
   */
  async releaseTokens() {
    const release = await loadReleaseConfig({ file: this.releaseConfigFile });
    const read = (value) => typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    return { github: read(release.github?.token), gitee: read(release.gitee?.token) };
  }
  /**
   * User labels for members, keyed by member id.
   * @returns {Promise<Record<string, string>>} tags.
   */
  async memberTags() {
    try {
      const parsed = JSON.parse(await readFile18(this.memberTagsFile, "utf8"));
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
    await mkdir15(this.dataDir, { recursive: true });
    await writeFile15(this.memberTagsFile, `${JSON.stringify(tags, null, 2)}
`, "utf8");
    return { ok: true, tags };
  }
  /**
   * Whether one target is busy with a deploy, an upgrade, or the announcement
   * window in front of a scheduled upgrade.
   *
   * `call_member` refuses while this is active. A deploy or upgrade restarts
   * the member's DSH (a local upgrade restarts this one), so a conversation
   * created or messaged now would lose its first turn to that restart. The
   * window starts with the announcement — a scheduled upgrade stops the
   * conversations ten minutes before it starts — and ends when the job that
   * replaced the announcement has settled.
   * @param {{id?: string, name?: string, ip?: string}} member target member row.
   * @returns {Promise<{active: boolean, kind?: string, phase?: string, since?: string, job?: string}>} state.
   */
  async memberMaintenance(member) {
    const ids = new Set([member?.id, member?.name, member?.ip].filter((value) => typeof value === "string" && value !== ""));
    const jobs = await this.deploy.list(50).catch(() => []);
    const active = jobs.find((job) => {
      if (job?.status !== "running" && job?.status !== "queued") return false;
      if (ids.has(String(job.member ?? ""))) return true;
      return ids.has(String(job.target?.host ?? ""));
    });
    if (active !== void 0 && active !== null) {
      return {
        active: true,
        kind: active.mode === "install" ? "\u90E8\u7F72" : "\u5347\u7EA7",
        job: String(active.id ?? ""),
        phase: String(active.phase ?? ""),
        ...typeof active.createdAt === "string" && active.createdAt !== "" ? { since: active.createdAt } : {}
      };
    }
    const id = typeof member?.id === "string" ? member.id : "";
    if (id === "") return { active: false };
    const schedule = await readScheduleFile(scheduleFile(this.dataDir));
    const prepare = schedule.last?.prepares?.[id];
    if (prepare === null || typeof prepare !== "object") return { active: false };
    const status = String(prepare.status ?? "");
    if (status === "skipped" || status === "failed" || status === "unsupported") return { active: false };
    const announcedAt = Date.parse(String(prepare.at ?? ""));
    if (!Number.isFinite(announcedAt)) return { active: false };
    if (Date.now() - announcedAt > UPGRADE_LEAD_MS + UPGRADE_PREPARE_GRACE_MS) return { active: false };
    const upgradedAt = Date.parse(String(schedule.last?.upgrades?.[id]?.at ?? ""));
    if (Number.isFinite(upgradedAt) && upgradedAt >= announcedAt) return { active: false };
    return { active: true, kind: "\u81EA\u52A8\u5347\u7EA7", phase: "prepare", since: new Date(announcedAt).toISOString() };
  }
  /**
   * The member conversations one main conversation tracks, for the Web
   * client's header chip.
   *
   * The browser only ever sees this flat row shape; the task table and the
   * scope store stay host concerns. A conversation without an identity yet is
   * still listed: the chip is exactly how an operator notices it.
   * @param {string} sessionId origin (main) conversation id.
   * @returns {Promise<{ok: boolean, total: number, running: number, conversations: object[]}>} rows and counts.
   */
  async memberConversations(sessionId) {
    const id = String(sessionId ?? "").trim();
    if (id === "") return { ok: true, total: 0, running: 0, conversations: [], stage: null, budget: null };
    const tasks = typeof this.memberTasks?.listForOrigin === "function" ? await this.memberTasks.listForOrigin(id).catch(() => []) : [];
    const scopes = await this.memberScopes();
    const conversations = memberConversationEntries(tasks, scopes);
    const originCwd = tasks.find((task) => typeof task?.originCwd === "string" && task.originCwd !== "")?.originCwd ?? "";
    const stage = originCwd === "" ? null : await this.productStage(originCwd).catch(() => null);
    let budget = null;
    if (stage !== null) {
      const explicit = callMemberBudgetFor(scopes[id]?.callMemberBudget, stage.stage);
      const limit = explicit ?? defaultCallMemberBudget(stage, tasks, scopes);
      const used = countCallMemberReplies(stage, tasks);
      budget = {
        stage: stage.stage,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        source: explicit === null ? "default" : "explicit",
        exhausted: used >= limit
      };
    }
    return {
      ok: true,
      ...memberConversationSummary(conversations),
      conversations,
      stage: stage === null ? null : { version: stage.version, stage: stage.stage, round: stage.round, label: PRODUCT_STAGE_SHORT[stage.stage] ?? "" },
      budget
    };
  }
  /**
   * Identity, standard role, work scope, keep flag, call_member budget and
   * compaction settings for conversations, keyed by conversation id.
   *
   * The file is only an optional hint book: a missing, unreadable, or damaged
   * file is the same as "nothing set yet", never a startup failure. Only the
   * fields that were actually set are stored; defaults are applied by readers
   * ({@link effectiveCompressPercent}).
   * @returns {Promise<Record<string, {identity?: string, role?: string, scope?: string, keep?: boolean, keepPrompt?: string, avoidLongJobs?: boolean, callMemberBudget?: Record<string, number>, budgetAudit?: boolean, note?: string, compressPercent?: number}>>} scopes.
   */
  async memberScopes() {
    try {
      const parsed = JSON.parse(await readFile18(this.memberScopesFile, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const scopes = {};
      for (const [rawId, value] of Object.entries(parsed)) {
        if (rawId.trim() === "") continue;
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const identity = savedScopeText(value.identity, MEMBER_IDENTITY_MAX);
        const rawRole = savedScopeText(value.role, 20);
        const role = rawRole !== null && MEMBER_ROLES.includes(rawRole) ? rawRole : null;
        const scope = savedScopeText(value.scope, MEMBER_SCOPE_MAX);
        const keep = typeof value.keep === "boolean" ? value.keep : void 0;
        const keepPrompt = savedScopeText(value.keepPrompt, MEMBER_KEEP_PROMPT_MAX);
        const avoidLongJobs = typeof value.avoidLongJobs === "boolean" ? value.avoidLongJobs : void 0;
        const budgetAudit = typeof value.budgetAudit === "boolean" ? value.budgetAudit : void 0;
        const waitMember = typeof value.waitMember === "boolean" ? value.waitMember : void 0;
        const compressOnTurnEnd = typeof value.compressOnTurnEnd === "boolean" ? value.compressOnTurnEnd : void 0;
        const callMemberBudget = savedCallMemberBudgets(value.callMemberBudget);
        const note = savedScopeText(value.note, MEMBER_NOTE_MAX);
        const compressPercent = savedScopeNumber(value.compressPercent, (candidate) => candidate >= 1 && candidate <= 100);
        if (identity === null && role === null && scope === null && keep === void 0 && keepPrompt === null && avoidLongJobs === void 0 && budgetAudit === void 0 && waitMember === void 0 && compressOnTurnEnd === void 0 && callMemberBudget === void 0 && note === null && compressPercent === void 0) continue;
        scopes[rawId.trim()] = {
          ...identity === null ? {} : { identity },
          ...role === null ? {} : { role },
          ...scope === null ? {} : { scope },
          ...keep === void 0 ? {} : { keep },
          ...keepPrompt === null ? {} : { keepPrompt },
          ...avoidLongJobs === void 0 ? {} : { avoidLongJobs },
          ...budgetAudit === void 0 ? {} : { budgetAudit },
          ...waitMember === void 0 ? {} : { waitMember },
          ...compressOnTurnEnd === void 0 ? {} : { compressOnTurnEnd },
          ...callMemberBudget === void 0 ? {} : { callMemberBudget },
          ...note === null ? {} : { note },
          ...compressPercent === void 0 ? {} : { compressPercent }
        };
      }
      return scopes;
    } catch {
      return {};
    }
  }
  /**
   * One conversation's scope, or null.
   * @param {string} conversationId conversation or session id.
   * @returns {Promise<{identity?: string, role?: string, scope?: string, keep?: boolean, keepPrompt?: string, avoidLongJobs?: boolean, callMemberBudget?: Record<string, number>, budgetAudit?: boolean, waitMember?: boolean, compressOnTurnEnd?: boolean, note?: string, compressPercent?: number}|null>} scope.
   */
  async memberScope(conversationId) {
    const id = String(conversationId ?? "").trim();
    if (id === "") return null;
    const scopes = await this.memberScopes();
    return scopes[id] ?? null;
  }
  /**
   * Merge and save one conversation's identity/work scope and settings.
   *
   * Only the fields present in the patch change. An empty string clears that
   * text field (the record is dropped when nothing remains). `role` is the
   * member's standard identity; only the member target is supposed to pass it.
   * `keep`, `keepPrompt`, `avoidLongJobs`, `budgetAudit` and `callMemberBudget`
   * are stored as given and only the self target uses them
   * (`callMemberBudget` is a per-stage map; there is no shared value). `note` is main-conversation-only
   * metadata and is never injected or delivered to the member.
   * `compressPercent` applies to both self and member conversations.
   * @param {string} conversationId conversation or session id.
   * @param {{identity?: unknown, role?: unknown, scope?: unknown, keep?: unknown, keepPrompt?: unknown, avoidLongJobs?: unknown, callMemberBudget?: unknown, note?: unknown, compressPercent?: unknown}} [patch] fields to change.
   * @returns {Promise<{ok: boolean, scopes: Record<string, object>, scope: object|null}>} saved scopes.
   */
  async setMemberScope(conversationId, patch = {}) {
    const id = String(conversationId ?? "").trim();
    if (id === "") throw new Error("conversation id is required");
    const normalized = normalizeMemberScopePatch(patch);
    const scopes = await this.memberScopes();
    const next = { ...scopes[id] ?? {} };
    if (normalized.identity !== void 0) {
      if (normalized.identity === null) delete next.identity;
      else next.identity = normalized.identity;
    }
    if (normalized.role !== void 0) {
      if (normalized.role === null) delete next.role;
      else next.role = normalized.role;
    }
    if (normalized.scope !== void 0) {
      if (normalized.scope === null) delete next.scope;
      else next.scope = normalized.scope;
    }
    if (normalized.keep !== void 0) next.keep = normalized.keep;
    if (normalized.keepPrompt !== void 0) {
      if (normalized.keepPrompt === null) delete next.keepPrompt;
      else next.keepPrompt = normalized.keepPrompt;
    }
    if (normalized.avoidLongJobs !== void 0) next.avoidLongJobs = normalized.avoidLongJobs;
    if (normalized.budgetAudit !== void 0) next.budgetAudit = normalized.budgetAudit;
    if (normalized.waitMember !== void 0) next.waitMember = normalized.waitMember;
    if (normalized.compressOnTurnEnd !== void 0) next.compressOnTurnEnd = normalized.compressOnTurnEnd;
    if (normalized.callMemberBudget !== void 0) {
      next.callMemberBudget = { ...next.callMemberBudget ?? {}, ...normalized.callMemberBudget };
    }
    if (normalized.note !== void 0) {
      if (normalized.note === null) delete next.note;
      else next.note = normalized.note;
    }
    if (normalized.compressPercent !== void 0) next.compressPercent = normalized.compressPercent;
    if (Object.keys(next).length === 0) delete scopes[id];
    else scopes[id] = next;
    await mkdir15(this.dataDir, { recursive: true });
    await writeFile15(this.memberScopesFile, `${JSON.stringify(scopes, null, 2)}
`, "utf8");
    return { ok: true, scopes, scope: scopes[id] ?? null };
  }
  /**
   * Every product stage state, keyed by project directory.
   *
   * A missing, unreadable, or damaged file is the same as "no stage yet"; one
   * invalid project record is dropped instead of failing the whole read.
   * @returns {Promise<Record<string, object>>} project directory -> state.
   */
  async productStages() {
    try {
      const parsed = JSON.parse(await readFile18(this.productStagesFile, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const stages = {};
      for (const [rawKey, value] of Object.entries(parsed)) {
        const key = productStageKey(rawKey);
        if (key === "") continue;
        const state = normalizeStoredProductStage(value);
        if (state !== null) stages[key] = state;
      }
      return stages;
    } catch {
      return {};
    }
  }
  /**
   * The product stage of one project, or null.
   * @param {string} cwd project directory.
   * @returns {Promise<object|null>} state.
   */
  async productStage(cwd) {
    const key = productStageKey(cwd);
    if (key === "") return null;
    const stages = await this.productStages();
    return stages[key] ?? null;
  }
  /**
   * Merge one stage patch and persist it.
   *
   * The transition rules live in `product-stage.mjs`: the product version moves
   * only on D -> A, the sub-stage round follows the iteration, and a stage or
   * round change clears the round's participation records. Writes are
   * serialised because the member monitors record participation concurrently.
   * @param {{cwd: string, stage?: unknown, round?: unknown, goals?: unknown, bySessionId?: string, now?: Date}} input stage patch.
   * @returns {Promise<{state: object, previous: object|null}>} saved state and the state before this call.
   */
  async setProductStage({ cwd, stage, round: round2, goals, bySessionId = "", now = /* @__PURE__ */ new Date() }) {
    const key = productStageKey(cwd);
    if (key === "") throw new Error("set_product_stage needs a project directory");
    const input = normalizeProductStageInput({ stage, round: round2, goals });
    return await this.#updateProductStages((stages) => {
      const previous = stages[key] ?? null;
      const state = applyProductStage(previous, input, now);
      state.updatedBy = String(bySessionId ?? "");
      stages[key] = state;
      return { state, previous };
    });
  }
  /**
   * Record that one member conversation answered inside the current stage round.
   *
   * Called once per accepted member reply, from both the `wait_member` path and
   * the fallback delivery path (they share the same reply table). A project
   * without a stage, or a reply that belongs to no known project, is ignored.
   * @param {{cwd?: string, conversationId?: string, turn?: number|null, at?: string}} facts participation fact.
   * @returns {Promise<boolean>} whether an active stage recorded the reply.
   */
  async noteMemberParticipation({ cwd, conversationId, turn = null, at = (/* @__PURE__ */ new Date()).toISOString() }) {
    const key = productStageKey(cwd);
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    if (key === "" || id === "") return false;
    return await this.#updateProductStages((stages) => {
      const state = stages[key];
      if (state === void 0) return false;
      const current = state.participation[id];
      const seen = Number.isSafeInteger(current?.turn) ? current.turn : -1;
      if (Number.isSafeInteger(turn) && turn < seen) return true;
      state.participation[id] = {
        turn: Number.isSafeInteger(turn) ? turn : Number.isSafeInteger(current?.turn) ? current.turn : null,
        at
      };
      return true;
    });
  }
  /**
   * Claim one budget-exhaustion audit slot for the project's current stage.
   *
   * At most three audits may run in one small stage (stage + round) and two
   * audits must be at least ten minutes apart. The claim is written inside the
   * serialised stage mutation, so concurrent snapshots cannot both start an
   * audit for the same window.
   * @param {{cwd?: string, now?: number}} [facts] project and claim time.
   * @returns {Promise<{count: number, lastAt: string}|null>} claimed slot, or null when refused.
   */
  async claimBudgetAudit({ cwd, now = Date.now() } = {}) {
    const key = productStageKey(cwd);
    const at = Number(now);
    if (key === "" || !Number.isFinite(at)) return null;
    return await this.#updateProductStages((stages) => {
      const state = stages[key];
      if (state === void 0) return null;
      const previous = state.audits ?? { count: 0, lastAt: "" };
      const count = Number.isSafeInteger(previous.count) ? previous.count : 0;
      if (count >= BUDGET_AUDIT_MAX) return null;
      const last = typeof previous.lastAt === "string" && previous.lastAt !== "" ? Date.parse(previous.lastAt) : Number.NaN;
      if (Number.isFinite(last) && at - last < BUDGET_AUDIT_INTERVAL_MS) return null;
      state.audits = { count: count + 1, lastAt: new Date(at).toISOString() };
      return { ...state.audits };
    });
  }
  /**
   * Give back a claimed audit slot after the audit could not be started.
   * @param {{cwd?: string, lastAt?: string}} [facts] project and the claim time.
   * @returns {Promise<boolean>} whether the matching claim was released.
   */
  async releaseBudgetAudit({ cwd, lastAt } = {}) {
    const key = productStageKey(cwd);
    if (key === "" || typeof lastAt !== "string" || lastAt === "") return false;
    return await this.#updateProductStages((stages) => {
      const state = stages[key];
      if (state?.audits?.lastAt !== lastAt) return false;
      const count = Number.isSafeInteger(state.audits.count) ? state.audits.count : 0;
      if (count <= 1) delete state.audits;
      else state.audits = { ...state.audits, count: count - 1 };
      return true;
    });
  }
  /**
   * Serialise one product-stage read/modify/write cycle.
   * @param {(stages: Record<string, object>) => any} mutate mutation, returning the call's result.
   * @returns {Promise<any>} the mutation's result after the file is written.
   */
  async #updateProductStages(mutate) {
    const run3 = this.productStageWrites.then(async () => {
      const stages = await this.productStages();
      const result = mutate(stages);
      await mkdir15(this.dataDir, { recursive: true });
      await writeFile15(this.productStagesFile, `${JSON.stringify(stages, null, 2)}
`, "utf8");
      return result;
    });
    this.productStageWrites = run3.then(() => {
    }, () => {
    });
    return await run3;
  }
  /**
   * Remove the temporary files a build leaves behind.
   *
   * `state.json` and `build.log` are the postmortem, so they stay; the source
   * worktree, work order and extracted package trees are only useful while the
   * build runs. The job named by `keep` also keeps its smoke screenshots until
   * the next build cleans them, so the panel's screenshot paths resolve.
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
    if (!existsSync14(this.jobRoot)) return [];
    const entries = await readdir9(this.jobRoot, { withFileTypes: true });
    const removed = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path27.join(this.jobRoot, entry.name);
      let state;
      try {
        state = await readState(dir);
      } catch {
        continue;
      }
      if (this.running.has(state.id) && state.id !== options.keep) continue;
      if (state.status === "created" || state.status === "needs-fix" || state.status === "learned") continue;
      await rm15(path27.join(dir, "src"), { recursive: true, force: true });
      if (state.id !== options.keep) await rm15(path27.join(dir, "smoke"), { recursive: true, force: true });
      await rm15(path27.join(dir, "work-order"), { recursive: true, force: true });
      if (options.keepDist !== true) {
        if (state.status === "done") await this.#pruneDist(path27.join(dir, "dist"));
        else await rm15(path27.join(dir, "dist"), { recursive: true, force: true });
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
    const entries = await readdir9(distDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await rm15(path27.join(distDir, entry.name), { recursive: true, force: true });
    }
  }
  /**
   * Direct (hysteria2) links that the gate has configured.
   *
   * The gate owns the link jobs and writes `links.json` beside the mesh data
   * directory. Build and deploy read it instead of asking the operator to
   * restate the link as a proxy URL, which is what kept the two features from
   * ever using it.
   * @returns {Promise<object[]>} live link records.
   */
  async #directLinks() {
    try {
      const raw = JSON.parse(await readFile18(path27.join(this.home, "hysteria", "links.json"), "utf8"));
      return Array.isArray(raw.links) ? raw.links : [];
    } catch {
      return [];
    }
  }
  /**
   * The direct link whose client is this member, if any.
   *
   * A link only helps traffic that originates on its client: the client's
   * packets enter the hysteria2 tunnel, the server supplies the internet
   * egress. The server side gains nothing.
   * @param {object|null} member member snapshot.
   * @returns {Promise<object|null>} link record.
   */
  async #linkFor(member) {
    return linkFor(await this.#directLinks(), member);
  }
  /**
   * Decide how a build reaches the internet.
   *
   * The direct link wins when the build host is its client, because the link
   * is a faster path to the same egress member. `proxy` and `proxyMember`
   * remain explicit overrides; `direct: true` forces the build host's own
   * network.
   * @param {{member: object|null, proxyUrl: string, proxyMember: object|null, direct?: boolean}} options build request pieces.
   * @returns {Promise<{kind: 'link'|'proxyMember'|'explicit'|'direct', url?: string, link?: object, proxyMember?: object, reason: string}>} egress plan.
   */
  async #resolveBuildEgress(options) {
    return resolveBuildEgress({ links: await this.#directLinks(), ...options });
  }
  /**
   * Start one build job in the background.
   *
   * `member` chooses the build host: empty or `local` runs the engine here,
   * anything else runs the same engine on that member over SSH. The archives
   * stay on that member unless `pullBack` is on, and a successful member build
   * upgrades the member from its own archive. `proxyMember` borrows another
   * member's internet access for the downloads; `proxy` is an explicit HTTP
   * proxy URL that both the engine and npm use.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string, keepDist?: boolean, member?: string, proxy?: string, proxyMember?: string, pullBack?: boolean, autoUpgrade?: boolean}} request build request.
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
    const pullBack = pullBackEnabled(request, this.config);
    const autoUpgrade = autoUpgradeEnabled(request, this.config);
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
    let proxyMember = null;
    if (proxyMemberId === "auto") {
      const link3 = await this.#linkFor(member);
      proxyMember = link3 === null ? null : everyone.find((candidate) => candidate.ip === link3.server?.ip) ?? null;
      if (proxyMember === null) {
        const picked = pickProxyMember(everyone);
        proxyMember = picked === null ? null : everyone.find((candidate) => candidate.id === picked) ?? null;
      }
    } else if (proxyMemberId !== "") {
      proxyMember = everyone.find((candidate) => candidate.id === proxyMemberId || candidate.name === proxyMemberId || candidate.ip === proxyMemberId) ?? null;
      if (proxyMember === null) throw new Error(`proxy member not found: ${proxyMemberId}`);
    }
    if (proxyMember !== null && proxyMember.id === "local") {
      throw new Error("the local host cannot proxy its own build; pick a member");
    }
    if (proxyMember !== null && String(proxyMember.system?.platform ?? "").toLowerCase().startsWith("win")) {
      throw new Error(`proxy member must be Linux; ${proxyMember.name} runs ${String(proxyMember.system?.platform)}`);
    }
    const egressPlan = await this.#resolveBuildEgress({
      member,
      proxyUrl,
      proxyMember,
      direct: request.direct === true
    });
    const buildStamp = await nextBuildStamp({
      stateFile: path27.join(this.dataDir, "build-stamp.json"),
      packagesDir: this.packagesDir
    });
    const job = await createJob({
      root: this.jobRoot,
      source,
      ref,
      targets,
      member: member?.id ?? null,
      proxy: egressPlan.kind === "link" || egressPlan.kind === "explicit" ? egressPlan.url : proxyMember !== null ? `member:${proxyMember.id}` : null,
      mode: member === null ? "local" : "remote",
      buildStamp
    });
    if (member !== null) {
      await updateState(job.dir, {
        memberName: member.name,
        memberIp: member.ip,
        percent: 0,
        proxyMember: proxyMember?.id ?? null,
        egress: egressPlan,
        pullBack,
        autoUpgrade
      });
    } else {
      await updateState(job.dir, {
        ...proxyMember !== null ? { proxyMember: proxyMember.id } : {},
        egress: egressPlan,
        percent: 0,
        pullBack,
        autoUpgrade
      });
    }
    this.logLine(`mesh build job ${job.id} created (${member === null ? "local" : member.name}, egress: ${egressPlan.reason})`);
    const promise = this.#runBuild(job, {
      member,
      proxyMember,
      proxyUrl,
      egressPlan,
      planOnly: request.planOnly === true,
      version: request.version,
      buildStamp: job.state.buildStamp,
      pullBack,
      autoUpgrade
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
   * @param {{member: object|null, proxyMember: object|null, proxyUrl: string, planOnly: boolean, version?: string, pullBack?: boolean, autoUpgrade?: boolean}} options run options.
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
      if (options.egressPlan?.kind === "link") {
        proxyUrl = options.egressPlan.url;
        await appendLog(job.dir, `outbound proxy ${proxyUrl} via direct link: ${options.egressPlan.reason}`);
        await updateState(job.dir, { proxy: proxyUrl, egress: options.egressPlan });
      } else if ((options.egressPlan === void 0 || options.egressPlan?.kind === "proxyMember") && options.proxyMember !== null && (options.member === null || options.member.id !== options.proxyMember.id)) {
        egress = await this.egress.start({ plan: await this.#memberSshPlan(options.proxyMember), member: options.proxyMember.name });
        proxyUrl = egress.url;
        await appendLog(job.dir, `outbound proxy ${proxyUrl} (${options.proxyMember.name})`);
        await updateState(job.dir, { proxy: proxyUrl, proxyMember: options.proxyMember.id });
      }
      const full = this.config.build?.full !== false;
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
          full,
          nodeVersion: typeof this.config.build?.nodeVersion === "string" && this.config.build.nodeVersion !== "" ? this.config.build.nodeVersion : void 0,
          smoke: this.config.build?.smoke === false ? false : void 0,
          smokeRequired: this.config.build?.requireSmoke === true,
          smokeChrome: typeof this.config.build?.chrome === "string" && this.config.build.chrome !== "" ? this.config.build.chrome : void 0
        });
        return;
      }
      const upgradeTarget = options.autoUpgrade === true ? memberBuildTarget(options.member) : null;
      const final = await this.remoteBuilder.run(job.dir, {
        plan: await this.#memberSshPlan(options.member),
        memberName: options.member.name,
        proxyUrl,
        buildStamp: options.buildStamp,
        heapMb: typeof this.config.build?.memberHeapMb === "number" ? this.config.build.memberHeapMb : void 0,
        releaseConfig: publishConfigured ? releaseConfig : null,
        pullBack: options.pullBack === true,
        // Stage the host's own archive only when the upgrade will use it.
        stageTarget: upgradeTarget,
        full
      });
      await this.#autoUpgradeAfterBuild(job, final, {
        member: options.member,
        autoUpgrade: options.autoUpgrade === true,
        full,
        upgradeTarget
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
   * Start the post-build upgrade on the member that ran the build.
   *
   * The archive was staged on that machine by the remote builder, so the
   * upgrade plan points at it directly: no release download and no upload from
   * the gateway. The job is the same detached upgrade every other entry point
   * starts, so restarting the member's DSH/gate cannot interrupt it. The build
   * has already succeeded at this point; an upgrade that cannot start is
   * recorded on the build (`autoUpgradeResult`) and never turns it red.
   * @param {{id: string, dir: string}} job build job.
   * @param {object} state final build state.
   * @param {{member: object|null, autoUpgrade: boolean, full: boolean, upgradeTarget: string|null}} options upgrade input.
   * @returns {Promise<void>} completion.
   */
  async #autoUpgradeAfterBuild(job, state, options) {
    if (state?.status !== "done" || options.autoUpgrade !== true) return;
    const member = options.member;
    const record = async (patch) => {
      const result = {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        member: member?.id ?? null,
        memberName: member?.name ?? null,
        ...patch
      };
      await updateState(job.dir, { autoUpgradeResult: result }).catch(() => {
      });
      return result;
    };
    if (member === null || member === void 0) {
      await record({ status: "skipped", reason: "\u672C\u673A\u7F16\u8BD1\u4E0D\u81EA\u52A8\u5347\u7EA7" });
      return;
    }
    if (options.full === false) {
      await appendLog(job.dir, "auto-upgrade skipped: a web-only package cannot upgrade an install").catch(() => {
      });
      await record({ status: "skipped", reason: "\u53EA Web \u5305\u4E0D\u80FD\u7528\u4E8E\u5347\u7EA7" });
      return;
    }
    if (member.dsh !== true) {
      await appendLog(job.dir, `auto-upgrade skipped: ${member.name} has no DSH install`).catch(() => {
      });
      await record({ status: "skipped", reason: "\u7F16\u8BD1\u673A\u8FD8\u6CA1\u6709\u5B89\u88C5 DSH\uFF0C\u6CA1\u6709\u53EF\u5347\u7EA7\u7684\u5B89\u88C5" });
      return;
    }
    if (options.upgradeTarget === null) {
      await appendLog(job.dir, "auto-upgrade skipped: this build has no target for the build host").catch(() => {
      });
      await record({ status: "skipped", reason: "\u8FD9\u6B21\u7F16\u8BD1\u7684\u76EE\u6807\u5E73\u53F0\u4E0E\u7F16\u8BD1\u673A\u4E0D\u5339\u914D" });
      return;
    }
    const artifact = pickArtifactForMember(state.artifacts, member);
    if (artifact === null) {
      await appendLog(job.dir, `auto-upgrade skipped: no ${options.upgradeTarget} artifact`).catch(() => {
      });
      await record({ status: "skipped", reason: `\u8FD9\u6B21\u7F16\u8BD1\u6CA1\u6709\u4EA7\u51FA ${options.upgradeTarget} \u5305` });
      return;
    }
    if (typeof artifact.stagedArchive !== "string" || artifact.stagedArchive === "" || typeof artifact.sha256 !== "string" || artifact.sha256 === "" || !Number.isSafeInteger(artifact.bytes)) {
      await appendLog(job.dir, "auto-upgrade skipped: the archive was not staged on the build host").catch(() => {
      });
      await record({ status: "skipped", reason: "\u4EA7\u7269\u6CA1\u6709\u6210\u529F\u6682\u5B58\u5230\u7F16\u8BD1\u673A\uFF0C\u65E0\u6CD5\u5728\u672C\u673A\u5347\u7EA7" });
      return;
    }
    try {
      const started = await this.startDeploy({
        member: member.id,
        mode: "upgrade",
        packageOnTarget: {
          path: artifact.stagedArchive,
          bytes: artifact.bytes,
          sha256: artifact.sha256
        }
      });
      const result = await record({
        status: "started",
        jobId: started.job.id,
        release: started.job.release ?? null,
        package: artifact.stagedArchive
      });
      await appendLog(job.dir, `auto-upgrade started on ${member.name}: ${result.jobId} (${artifact.stagedArchive})`).catch(() => {
      });
      this.logLine(`mesh build ${job.id} auto-upgrade ${result.jobId} started on ${member.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const busy = Number(error?.status) === 409;
      await appendLog(job.dir, `auto-upgrade could not start: ${message}`).catch(() => {
      });
      await record({ status: busy ? "skipped" : "failed", reason: message });
      this.logLine(`mesh build ${job.id} auto-upgrade did not start: ${message}`);
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
    const { state } = await readWireGuardState({ file: path27.join(this.home, "wireguard", "state.json") });
    const peer = state?.server?.peers?.find((candidate) => candidate?.ip === member.ip);
    if (peer !== void 0 && peer !== null) {
      if (typeof peer.sshUser === "string" && peer.sshUser !== "") user = peer.sshUser;
      if (Number.isSafeInteger(peer.sshPort)) port = peer.sshPort;
      if (typeof peer.publicKey === "string" && peer.publicKey !== "") {
        const digest = createHash8("sha256").update(peer.publicKey).digest("hex");
        const candidate = path27.join(this.home, "wireguard", "ssh", `${digest}.key`);
        if (existsSync14(candidate)) identityFile = candidate;
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
      logFile: path27.join(dir, "build.log"),
      stateFile: path27.join(dir, "state.json"),
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
    if (!existsSync14(this.jobRoot)) return [];
    const entries = await readdir9(this.jobRoot, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const state = await readState(path27.join(this.jobRoot, entry.name));
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
      publish: state.publish ?? null,
      pullBack: state.pullBack ?? null,
      pulledBack: state.pulledBack ?? null,
      remoteDirKept: state.remoteDirKept ?? null,
      autoUpgrade: state.autoUpgrade ?? null,
      autoUpgradeResult: state.autoUpgradeResult ?? null
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
    const parsed = JSON.parse(await readFile18(this.recipesPath, "utf8"));
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
   * The newest package published under the configured `latest` tag.
   *
   * Gitee is probed first because a domestic gateway usually reaches it
   * directly; GitHub is the fallback and may be slow or blocked. The result is
   * cached for a few seconds so opening the dialog and then starting the
   * upgrade do not read the manifest twice.
   * @param {{refresh?: boolean}} [options] refresh forces a new read.
   * @returns {Promise<object>} normalized release.
   */
  async latestRelease(options = {}) {
    const config = await loadReleaseConfig({ file: this.releaseConfigFile });
    const sources = latestManifestSources(config);
    const manifests = [];
    if (typeof sources.gitee === "string" && sources.gitee !== "") manifests.push({ provider: "gitee", url: sources.gitee });
    if (typeof sources.github === "string" && sources.github !== "") manifests.push({ provider: "github", url: sources.github });
    const urls = manifests.map((entry) => entry.url);
    if (urls.length === 0) {
      return { ok: false, configured: false, assets: [], manifestUrls: [], manifests: [], error: "\u8FD8\u6CA1\u6709\u914D\u7F6E Release \u53D1\u5E03" };
    }
    const cached = this.latestReleaseCache;
    if (options.refresh !== true && cached !== null && Date.now() - cached.at < 3e4) return cached.value;
    try {
      const found = await fetchLatestManifest({ urls, timeoutMs: 15e3 });
      let provider = "github";
      try {
        provider = /(?:^|\.)gitee\.com$/iu.test(new URL(found.url).hostname) ? "gitee" : "github";
      } catch {
      }
      const value = { ...normalizeLatestManifest(found.manifest, { provider, manifestUrls: urls }), manifests };
      this.latestReleaseCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cached !== null) return { ...cached.value, stale: true, error: message };
      return { ok: false, configured: true, assets: [], manifestUrls: urls, manifests, error: message };
    }
  }
  /**
   * Archives already present on one member.
   *
   * The gateway lists its own `~/.dsh/packages` (plus the build staging it may
   * have). A peer is asked over SSH; both `~/.dsh/packages` and
   * `~/.dsh/mesh/upgrade` are scanned, because a build host leaves its archive
   * in the latter rather than pulling it back to the gateway.
   * @param {string} memberId member id, name, or VPN address.
   * @returns {Promise<{ok: boolean, member: string, packages: object[], error?: string}>} listing.
   */
  async memberPackages(memberId) {
    const wanted = typeof memberId === "string" ? memberId.trim() : "";
    if (wanted === "") throw new Error("member is required");
    const snapshot = await this.members();
    const all = [snapshot.local, ...snapshot.members].filter(Boolean);
    const member = all.find((candidate) => candidate.id === wanted || candidate.name === wanted || candidate.ip === wanted);
    if (member === void 0) throw new Error(`member not found: ${wanted}`);
    if (member.id === "local" || member.kind === "self") {
      return { ok: true, member: member.id, packages: await this.#localTargetPackages() };
    }
    try {
      return { ok: true, member: member.id, packages: await this.#remoteTargetPackages(member) };
    } catch (error) {
      return { ok: false, member: member.id, packages: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
  /**
   * Read archives from the gateway's own package cache and build staging.
   * @returns {Promise<object[]>} packages.
   */
  async #localTargetPackages() {
    const packages = [];
    const seen = /* @__PURE__ */ new Set();
    const walk = async (dir, depth) => {
      if (depth < 0) return;
      const entries = await readdir9(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const file = path27.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth > 0) await walk(file, depth - 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const parsed = packageTargetFromName(entry.name);
        if (parsed === null || seen.has(file)) continue;
        const info = await stat13(file).catch(() => null);
        if (info === null) continue;
        seen.add(file);
        const sidecar = await readFile18(`${file}.sha256`, "utf8").catch(() => "");
        const sha256 = /^([a-f0-9]{64})\b/iu.exec(sidecar)?.[1]?.toLowerCase() ?? null;
        packages.push({ name: entry.name, path: file, bytes: info.size, mtime: info.mtime.toISOString(), sha256, ...parsed });
      }
    };
    await walk(this.packagesDir, 0);
    await walk(path27.join(this.dataDir, "upgrade"), 2);
    packages.sort((left, right) => right.mtime.localeCompare(left.mtime));
    return packages;
  }
  /**
   * The home a member's service runs under.
   *
   * The SSH user and the service user can differ; the member reports its own
   * home, so prefer that over the SSH login's `$HOME`.
   * @param {object} member member snapshot.
   * @param {{user: string, os: 'linux'|'windows'}} plan SSH plan.
   * @returns {string} home directory.
   */
  #memberHome(member, plan) {
    const reported = typeof member.system?.home === "string" ? member.system.home.trim() : "";
    if (reported !== "") return reported;
    if (plan.os === "windows") return `C:\\Users\\${plan.user}`;
    return plan.user === "root" ? "/root" : `/home/${plan.user}`;
  }
  /**
   * Ask a peer for its archives over SSH.
   * @param {object} member member snapshot.
   * @returns {Promise<object[]>} packages.
   */
  async #remoteTargetPackages(member) {
    const plan = await this.#memberSshPlan(member);
    const runner = new SshRunner({ ...plan, os: plan.os });
    const script = listPackagesScript(plan.os, this.#memberHome(member, plan));
    let stdout = "";
    if (plan.os === "windows") {
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      ({ stdout } = await runner.runProcess("ssh", [
        ...runner.sshOptions(),
        runner.target(),
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
      ]));
    } else {
      ;
      ({ stdout } = await runner.runProcess("ssh", [
        ...runner.sshOptions(),
        runner.target(),
        "bash -s"
      ], script));
    }
    return parseTargetPackageList(stdout);
  }
  /**
   * Validate one archive the operator picked from the target member.
   *
   * The path must be under that member's package cache or build staging, the
   * archive name must match the target's platform, and the digest is computed
   * here instead of trusted from the browser.
   * @param {object} member target member.
   * @param {{path?: string, bytes?: number, sha256?: string}} request selected package.
   * @returns {Promise<{path: string, bytes: number, sha256: string, name: string, os: 'linux'|'windows'}>} verified package.
   */
  async #resolveTargetPackage(member, request) {
    const file = typeof request?.path === "string" ? request.path.trim() : "";
    if (file === "") throw new Error("targetPackage.path is required");
    const plan = await this.#memberSshPlan(member);
    const os11 = plan.os === "windows" ? "windows" : "linux";
    const home = this.#memberHome(member, plan);
    if (!isAllowedPackagePath(file, home, os11)) {
      throw new Error("\u76EE\u6807\u5305\u4E0D\u5728\u8BE5\u6210\u5458\u7684 ~/.dsh/packages \u6216 ~/.dsh/mesh/upgrade \u76EE\u5F55\u5185");
    }
    const name = file.split(/[\\/]/u).pop() ?? "";
    const parsed = packageTargetFromName(name);
    if (parsed === null) throw new Error(`\u4E0D\u662F\u53EF\u8BC6\u522B\u7684\u90E8\u7F72\u5305\uFF1A${name}`);
    if (parsed.os !== os11) throw new Error(`\u5305\u5E73\u53F0 ${parsed.os} \u4E0E\u6210\u5458 ${os11} \u4E0D\u5339\u914D`);
    const memberTarget = memberBuildTarget(member);
    if (memberTarget !== null && memberTarget !== parsed.target) {
      throw new Error(`\u5305\u5E73\u53F0 ${parsed.target} \u4E0E\u6210\u5458 ${memberTarget} \u4E0D\u5339\u914D`);
    }
    let bytes = 0;
    let sha256 = "";
    if (member.id === "local" || member.kind === "self") {
      const info = await stat13(file).catch(() => null);
      if (info === null || !info.isFile()) throw new Error(`\u76EE\u6807\u5305\u4E0D\u5B58\u5728\uFF1A${file}`);
      bytes = info.size;
      sha256 = await sha256File(file);
    } else {
      const runner = new SshRunner({ ...plan, os: os11 });
      const size = await runner.remoteSize(file);
      if (size === null) throw new Error(`\u76EE\u6807\u5305\u4E0D\u5B58\u5728\uFF1A${file}`);
      bytes = size;
      if (os11 === "windows") {
        const { stdout } = await runner.runProcess("ssh", [
          ...runner.sshOptions(),
          runner.target(),
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath ${powershellQuote(file)}).Hash"`
        ]);
        sha256 = String(stdout).trim().toLowerCase();
      } else {
        const { stdout } = await runner.runProcess("ssh", [
          ...runner.sshOptions(),
          runner.target(),
          `sha256sum -- ${shellQuote(file)}`
        ]);
        sha256 = String(stdout).trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
      }
    }
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`\u65E0\u6CD5\u8BA1\u7B97\u76EE\u6807\u5305\u7684\u6821\u9A8C\u548C\uFF1A${name}`);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`\u76EE\u6807\u5305\u662F\u7A7A\u6587\u4EF6\uFF1A${name}`);
    if (Number.isSafeInteger(Number(request?.bytes)) && Number(request.bytes) > 0 && Number(request.bytes) !== bytes) {
      throw new Error(`\u76EE\u6807\u5305\u5927\u5C0F\u53D8\u4E86\uFF1A\u671F\u671B ${String(request.bytes)}\uFF0C\u5B9E\u9645 ${String(bytes)}`);
    }
    const expected = typeof request?.sha256 === "string" ? request.sha256.trim().toLowerCase() : "";
    if (expected !== "" && expected !== sha256) throw new Error("\u76EE\u6807\u5305\u7684\u6821\u9A8C\u548C\u4E0E\u5217\u8868\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
    return { path: file, bytes, sha256, name, os: os11 };
  }
  /**
   * Local deployment packages. The fixed directory is `~/.dsh/packages`.
   *
   * Only archives that name a `dsh-mesh` deployment target are offered. The
   * directory is a plain cache that other flows write to as well (a plugin
   * bundle, for instance, is a `.tgz` too), and an archive without a platform
   * cannot be deployed: extracted on a member it has no runtime to start.
   * Filtering here keeps such a file out of the panel list and out of the
   * scheduled upgrade candidates.
   * @returns {Promise<object>} package list.
   */
  async packages() {
    const entries = await readdir9(this.packagesDir, { withFileTypes: true }).catch(() => []);
    const packages = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parsed = packagePlatformFromName(entry.name);
      if (parsed === null) continue;
      const file = path27.join(this.packagesDir, entry.name);
      const info = await stat13(file).catch(() => null);
      if (info === null) continue;
      packages.push({
        name: entry.name,
        path: file,
        bytes: info.size,
        mtime: info.mtime.toISOString(),
        target: parsed.os
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
    const parsed = packageInfo(path27.basename(job?.package ?? ""));
    if (parsed === null) return;
    member.deployment = { version: parsed.version, buildStamp: parsed.buildStamp, inferred: true };
  }
  /**
   * Announce one member's imminent auto-upgrade to its running conversations.
   *
   * The member owns those conversations, so the gateway only asks: it POSTs
   * `/v1/upgrade/prepare`, the member classifies its running agents (leader /
   * member / plain) and injects the matching stop message. A member older than
   * this release has no such endpoint; that is reported, not retried, and the
   * upgrade still runs.
   *
   * Nothing is announced when the member is already on the newest build: the
   * upgrade tick would only skip it, and stopping conversations for nothing
   * would be worse than the missed notice.
   * @param {string} memberId member id.
   * @returns {Promise<{status: string, member?: string, reason?: string, announced?: number, counts?: object}>} outcome.
   */
  async scheduledPrepareUpgrade(memberId) {
    const snapshot = await this.members();
    const everyone = [snapshot.local, ...snapshot.members].filter(Boolean);
    const member = everyone.find((candidate2) => candidate2.id === memberId);
    if (member === void 0) return { status: "skipped", reason: "\u6210\u5458\u4E0D\u5728\u5F53\u524D\u5217\u8868", member: memberId };
    if (member.online === false) return { status: "skipped", reason: "\u79BB\u7EBF", member: member.name };
    if (member.id === "local" || member.kind === "self") return { status: "skipped", reason: "\u672C\u673A\u6CA1\u6709\u81EA\u52A8\u5347\u7EA7", member: member.name };
    const deployJobs = await this.deployJobs(50);
    this.#applyInferredDeployment(member, deployJobs);
    const packages = (await this.packages()).packages;
    const release = await this.#scheduledRelease();
    const candidate = planMemberUpgrade(member, packages, release);
    if (candidate.package === void 0) {
      return { status: "skipped", member: member.name, reason: candidate.reason };
    }
    return this.#announceUpgrade(member);
  }
  /**
   * Ask one member to stop the conversations an upgrade will interrupt.
   * @param {object} member member row.
   * @returns {Promise<{status: string, member: string, reason?: string, announced?: number, counts?: object}>} outcome.
   */
  async #announceUpgrade(member) {
    if (member.dsh !== true || typeof member.ip !== "string" || member.ip === "") {
      return { status: "skipped", member: member.name, reason: "\u6210\u5458\u6CA1\u6709\u5728\u8FD0\u884C\u7684 DSH" };
    }
    let response;
    try {
      response = await memberInteropRequest(this, {
        address: member.ip,
        path: "/v1/upgrade/prepare",
        body: {},
        timeoutMs: 2e4
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logLine(`scheduled upgrade ${member.name}: could not announce the restart: ${reason}`);
      return { status: "failed", member: member.name, reason };
    }
    if (response.unsupported) {
      this.logLine(`scheduled upgrade ${member.name}: the member's release has no /v1/upgrade/prepare; its conversations are not stopped`);
      return { status: "unsupported", member: member.name, reason: "\u6210\u5458\u7248\u672C\u8FC7\u65E7\uFF0C\u4E0D\u652F\u6301\u5347\u7EA7\u524D\u505C\u6B62\u901A\u77E5" };
    }
    if (!response.ok) {
      const reason = response.data?.error?.message ?? `HTTP ${String(response.status)}`;
      this.logLine(`scheduled upgrade ${member.name}: the announcement was refused: ${reason}`);
      return { status: "failed", member: member.name, reason };
    }
    const announced = Number.isSafeInteger(response.data?.announced) ? response.data.announced : 0;
    const counts = response.data?.counts ?? {};
    this.announcedUpgrades.set(member.id, { at: (/* @__PURE__ */ new Date()).toISOString(), counts });
    this.logLine(`scheduled upgrade ${member.name}: announced to ${String(announced)} running conversation(s) (leader ${String(counts.leader ?? 0)}, member ${String(counts.member ?? 0)}, plain ${String(counts.plain ?? 0)})`);
    return {
      status: response.data?.already === true ? "already" : "announced",
      member: member.name,
      announced,
      counts
    };
  }
  /**
   * Make sure the stop messages went out before an upgrade starts.
   *
   * The scheduler normally announced ten minutes earlier. When this process
   * was not alive for that tick (a restart inside the window), the
   * announcement happens now and the upgrade still proceeds: the alternative —
   * skipping the upgrade — would silently drop a scheduled deployment.
   * @param {object} member member row.
   * @returns {Promise<void>} completion.
   */
  async #ensureUpgradeAnnounced(member) {
    if (member.dsh !== true || typeof member.ip !== "string" || member.ip === "") return;
    const previous = this.announcedUpgrades.get(member.id);
    if (previous !== void 0) {
      const at = Date.parse(previous.at);
      if (Number.isFinite(at) && Date.now() - at <= UPGRADE_ANNOUNCE_WINDOW_MS) return;
    }
    const result = await this.#announceUpgrade(member).catch((error) => ({
      status: "failed",
      member: member.name,
      reason: error instanceof Error ? error.message : String(error)
    }));
    if (result.status === "announced" || result.status === "already") {
      this.logLine(`scheduled upgrade ${member.name}: the stop messages went out at the upgrade tick (the ten-minute lead was missed)`);
    }
  }
  /**
   * One member's scheduled auto-upgrade.
   *
   * The archive comes from the gateway cache when that copy is the newest one;
   * otherwise the member downloads the matching `latest` release asset itself
   * (Gitee first, GitHub through an egress member). The job is started and left
   * detached; the scheduler records "started" instead of holding its tick open
   * for a download that may take minutes.
   * @param {string} memberId member id.
   * @returns {Promise<{status: string, member?: string, package?: string, source?: 'local'|'release', jobId?: string, reason?: string}>} outcome.
   */
  async scheduledUpgradeMember(memberId) {
    if (this.running.size > 0) return { status: "skipped", reason: "\u7F16\u8BD1\u4EFB\u52A1\u8FD8\u5728\u8FD0\u884C", member: memberId };
    const snapshot = await this.members();
    const everyone = [snapshot.local, ...snapshot.members].filter(Boolean);
    const member = everyone.find((candidate2) => candidate2.id === memberId);
    if (member === void 0) return { status: "skipped", reason: "\u6210\u5458\u4E0D\u5728\u5F53\u524D\u5217\u8868", member: memberId };
    if (member.online === false) return { status: "skipped", reason: "\u79BB\u7EBF", member: member.name };
    const deployJobs = await this.deployJobs(50);
    this.#applyInferredDeployment(member, deployJobs);
    const packages = (await this.packages()).packages;
    const release = await this.#scheduledRelease();
    const candidate = planMemberUpgrade(member, packages, release);
    if (candidate.package === void 0) {
      return { status: "skipped", member: member.name, reason: candidate.reason };
    }
    try {
      await this.#ensureUpgradeAnnounced(member);
      return { status: "started", ...await this.#startScheduledUpgrade(member, candidate) };
    } catch (error) {
      return { status: "failed", member: member.name, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  /**
   * One scheduled upgrade: bring every member that is behind to its newest
   * source, peers before the local gateway.
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
    const release = await this.#scheduledRelease();
    const ordered = [
      ...everyone.filter((member) => member.id !== "local" && member.kind !== "self"),
      ...everyone.filter((member) => member.id === "local" || member.kind === "self")
    ];
    const upgraded = [];
    const failed = [];
    const skipped2 = [];
    for (const member of ordered) {
      const candidate = planMemberUpgrade(member, packages, release);
      if (candidate.package === void 0) {
        skipped2.push({ member: member.name, reason: candidate.reason });
        continue;
      }
      try {
        const result = await this.#startScheduledUpgrade(member, candidate);
        upgraded.push({ member: result.member, package: result.package, source: result.source, job: result.jobId });
        if (member.id === "local" || member.kind === "self") continue;
        const final = await this.waitDeploy(result.jobId, { timeoutMs: 20 * 6e4 }).catch(() => null);
        if (final !== null && final.status === "failed") {
          failed.push({ member: member.name, reason: final.error ?? "\u5347\u7EA7\u5931\u8D25" });
        }
      } catch (error) {
        failed.push({ member: member.name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (upgraded.length === 0 && failed.length === 0) {
      return { status: "skipped", reason: "\u6240\u6709\u6210\u5458\u90FD\u5DF2\u7ECF\u662F\u53EF\u7528\u7684\u6700\u65B0\u90E8\u7F72", skipped: skipped2 };
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
   * Start one scheduled upgrade from a planned candidate.
   *
   * A release candidate carries only the target: `upgradeMember` resolves the
   * asset and its manifest URLs again (30 s cache), so the archive name and
   * SHA-256 cannot go stale between planning and downloading.
   * @param {object} member target member.
   * @param {{source: 'local'|'release', package: object, target: string|null}} candidate planned source.
   * @returns {Promise<{member: string, package: string, source: 'local'|'release', jobId: string}>} started job.
   */
  async #startScheduledUpgrade(member, candidate) {
    const request = candidate.source === "release" ? { member: member.id, release: { target: candidate.target, refresh: true } } : { member: member.id, package: candidate.package.name };
    const result = await this.upgradeMember(request);
    const via = candidate.source === "release" ? "latest" : "gateway cache";
    this.logLine(`scheduled upgrade ${member.name} -> ${candidate.package.name} via ${via} (${result.job.id})`);
    return { member: member.name, package: candidate.package.name, source: candidate.source, jobId: result.job.id };
  }
  /**
   * The published `latest` release for a scheduled upgrade.
   *
   * A deployment without release settings, or one whose manifest cannot be
   * read, simply has no release candidates; the gateway cache still works.
   * @returns {Promise<object|null>} normalized release, or null.
   */
  async #scheduledRelease() {
    try {
      const release = await this.latestRelease({ refresh: true });
      return release !== null && typeof release === "object" && release.ok === true ? release : null;
    } catch (error) {
      this.logLine(`scheduled upgrade cannot read the latest release: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
  /**
   * The release publishing settings the panel may see (tokens masked).
   * @returns {Promise<object>} sanitized config and the manifest URLs.
   */
  async releaseSettings() {
    const config = await this.#healReleaseOwners(await loadReleaseConfig({ file: this.releaseConfigFile }));
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
  /**
   * Fill a stored config's missing owners from its tokens.
   *
   * A token-only setup stores the owner as soon as it is known; a config that
   * predates that (or a save whose provider was unreachable) still shows the
   * owner here, so the panel never asks the operator for an account name.
   * Failures are ignored: publishing retries the lookup through its proxy.
   * @param {object} config loaded config.
   * @returns {Promise<object>} config, possibly with owners filled in.
   */
  async #healReleaseOwners(config) {
    const missing = ["github", "gitee"].filter((provider) => config?.[provider]?.enabled === true && String(config[provider].owner ?? "") === "");
    if (missing.length === 0) return config;
    const owners = {};
    for (const provider of missing) {
      try {
        owners[provider] = await detectReleaseOwner(provider, { token: config[provider].token });
        this.logLine(`release ${provider} owner detected from token: ${owners[provider]}`);
      } catch {
      }
    }
    if (Object.keys(owners).length === 0) return config;
    return await saveReleaseConfig({
      file: this.releaseConfigFile,
      input: {
        enabled: config.enabled,
        tag: config.tag,
        partBytes: config.partBytes,
        github: { owner: owners.github ?? config.github.owner, repo: config.github.repo },
        gitee: { owner: owners.gitee ?? config.gitee.owner, repo: config.gitee.repo, branch: config.gitee.branch }
      }
    });
  }
  async saveReleaseSettings(request) {
    const input = request?.config !== null && typeof request?.config === "object" ? request.config : request;
    const resolved = await this.#resolveReleaseOwners(input);
    const config = await saveReleaseConfig({ file: this.releaseConfigFile, input: resolved.input });
    this.logLine(`release settings saved (tag ${config.tag}, github ${config.github.enabled ? "on" : "off"}, gitee ${config.gitee.enabled ? "on" : "off"})`);
    return {
      ok: true,
      config: sanitizeReleaseConfig(config),
      manifestUrls: latestManifestUrls(config),
      configured: config.github.enabled || config.gitee.enabled,
      warnings: resolved.warnings
    };
  }
  /**
   * Fill the owner half of a token-only release config from the provider.
   *
   * The panel deliberately asks for nothing but a token; the account name is
   * whatever the token belongs to. An invalid token fails the save, so the
   * operator sees it immediately instead of at the end of a build; an
   * unreachable provider only warns, because publishing retries the lookup
   * through the build's egress proxy.
   * @param {object} input raw panel input.
   * @returns {Promise<{input: object, warnings: string[]}>} input with owners and any warnings.
   */
  async #resolveReleaseOwners(input) {
    const warnings = [];
    const next = { ...input };
    for (const provider of ["github", "gitee"]) {
      const entry = input?.[provider];
      if (entry === null || typeof entry !== "object") continue;
      const token = typeof entry.token === "string" ? entry.token.trim() : "";
      if (token === "" || String(entry.owner ?? "").trim() !== "") continue;
      try {
        const owner = await detectReleaseOwner(provider, { token });
        next[provider] = { ...entry, owner };
        this.logLine(`release ${provider} owner detected from token: ${owner}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/HTTP 401|HTTP 403|无效或缺少/iu.test(message)) throw error;
        warnings.push(`${provider} \u8D26\u53F7\u6682\u65F6\u65E0\u6CD5\u8BC6\u522B\uFF08${message}\uFF09\uFF1B\u53D1\u5E03\u65F6\u4F1A\u518D\u8BD5\u4E00\u6B21`);
      }
    }
    return { input: next, warnings };
  }
  /**
   * Delete one package (and its `.sha256` sidecar) from the packages directory.
   * @param {{name: string}} request package file name.
   * @returns {Promise<{ok: boolean, removed: string[]}>} removed files.
   */
  async removePackage(request) {
    const name = typeof request?.name === "string" ? request.name.trim() : "";
    if (name === "" || name !== path27.basename(name) || name.startsWith(".")) {
      throw new Error("package name is invalid");
    }
    if (!/\.(?:7z|zip|tar\.gz|tgz)$/iu.test(name)) throw new Error(`not a package name: ${name}`);
    const file = path27.join(this.packagesDir, name);
    const info = await stat13(file).catch(() => null);
    if (info === null || !info.isFile()) throw new Error(`package not found: ${name}`);
    const removed = [];
    await rm15(file, { force: true });
    removed.push(file);
    const sidecar = `${file}.sha256`;
    if (existsSync14(sidecar)) {
      await rm15(sidecar, { force: true });
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
    const candidates = path27.isAbsolute(raw) ? [raw] : [path27.join(this.packagesDir, raw), path27.join(this.repositoryRoot, "dist", raw)];
    for (const file of candidates) {
      const info = await stat13(file).catch(() => null);
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
   * @param {{host?: string, member?: string, package?: string, packageOnTarget?: {path: string, bytes: number, sha256: string}, release?: {target: string, sha256?: string, refresh?: boolean}, targetPackage?: {path: string, bytes?: number, sha256?: string}, mode?: 'install'|'upgrade'}} request target and package source.
   * @returns {Promise<{ok: boolean, job: object, member: object|null, packagePath: string, layout: string}>} queued job.
   */
  async startDeploy(request) {
    const mode = request.mode === "upgrade" ? "upgrade" : request.mode === "test" ? "test" : "install";
    const test = request.test === true || mode === "test";
    if (test) throw new Error("\u6307\u9488\u5E03\u5C40\u6CA1\u6709\u5355\u72EC\u7684\u300C\u6D4B\u8BD5\u5347\u7EA7\u300D\uFF1A\u76F4\u63A5\u8FD0\u884C\u300C\u5347\u7EA7\u300D\uFF0C\u5065\u5EB7\u68C0\u67E5\u5931\u8D25\u4F1A\u81EA\u52A8\u56DE\u9000\u5230\u4E0A\u4E00\u4E2A release");
    const host = typeof request.host === "string" ? request.host.trim() : "";
    const memberId = typeof request.member === "string" ? request.member.trim() : "";
    let packageOnTarget = request.packageOnTarget !== null && typeof request.packageOnTarget === "object" ? request.packageOnTarget : null;
    const releaseRequest = request.release !== null && typeof request.release === "object" ? request.release : null;
    const targetPackageRequest = request.targetPackage !== null && typeof request.targetPackage === "object" ? request.targetPackage : null;
    if (releaseRequest !== null && targetPackageRequest !== null) {
      throw new Error("\u4E00\u6B21\u5347\u7EA7\u53EA\u80FD\u9009\u62E9\u4E00\u4E2A\u5305\u6765\u6E90");
    }
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
    if (mode === "upgrade" && member !== void 0) await this.#ensureUpgradeAnnounced(member);
    let packagePath = "";
    let os11 = "linux";
    let packageDescriptor = null;
    let acquire = null;
    let downloadRequest = request;
    if (targetPackageRequest !== null) {
      if (member === void 0) throw new Error("\u76EE\u6807\u6210\u5458\u5DF2\u6709\u5305\u9700\u8981\u4E00\u4E2A\u6210\u5458");
      const resolved = await this.#resolveTargetPackage(member, targetPackageRequest);
      packagePath = resolved.path;
      os11 = resolved.os;
      packageOnTarget = { path: resolved.path, bytes: resolved.bytes, sha256: resolved.sha256, keep: true };
    } else if (releaseRequest !== null) {
      if (member === void 0) throw new Error("latest tag \u9700\u8981\u6307\u5B9A\u4E00\u4E2A\u6210\u5458");
      if (mode === "install") {
        throw new Error("\u65B0\u6210\u5458\u5B89\u88C5\u8BF7\u4F7F\u7528\u672C\u673A\u90E8\u7F72\u5305\u6216\u76EE\u6807\u6210\u5458\u5DF2\u6709\u5305\uFF1Blatest tag \u53EA\u7528\u4E8E\u5347\u7EA7");
      }
      const target = typeof releaseRequest.target === "string" ? releaseRequest.target.trim() : "";
      if (target === "") throw new Error("release.target is required");
      const memberTarget = memberBuildTarget(member);
      if (memberTarget !== null && memberTarget !== target) {
        throw new Error(`\u5305\u5E73\u53F0 ${target} \u4E0E\u6210\u5458 ${memberTarget} \u4E0D\u5339\u914D`);
      }
      const latest = await this.latestRelease({ refresh: releaseRequest.refresh === true });
      if (latest.ok !== true) throw new Error(latest.error ?? "\u53D1\u5E03\u6E05\u5355\u4E0D\u53EF\u7528");
      const asset = selectLatestAsset(latest, target);
      if (asset === null) throw new Error(`latest tag \u91CC\u6CA1\u6709 ${target} \u7684\u90E8\u7F72\u5305`);
      const manifests = latest.manifests ?? latest.manifestUrls;
      if (member.id === "local" || member.kind === "self") {
        const link3 = request.direct === true ? null : resolveDeployLinkProxy({
          links: await this.#directLinks(),
          target: member,
          wanted: typeof request.proxyMember === "string" ? request.proxyMember : ""
        });
        acquire = {
          name: asset.name,
          bytes: asset.bytes,
          sha256: asset.sha256,
          manifests,
          prefer: "gitee",
          ...link3 === null || typeof link3.url !== "string" || link3.url === "" ? {} : { proxy: link3.url }
        };
        packagePath = path27.join(this.packagesDir, asset.name);
        os11 = asset.os;
      } else {
        packagePath = asset.name;
        os11 = asset.os;
        packageDescriptor = { name: asset.name, bytes: asset.bytes, sha256: asset.sha256, local: false };
        downloadRequest = {
          ...request,
          release: { ...releaseRequest, manifests, prefer: "gitee" }
        };
      }
    } else if (packageOnTarget !== null) {
      packagePath = String(packageOnTarget.path ?? "").trim();
      if (packagePath === "") throw new Error("packageOnTarget.path is required");
      os11 = /win(?:dows)?/iu.test(path27.basename(packagePath)) ? "windows" : member?.system?.platform?.toLowerCase().startsWith("win") ? "windows" : "linux";
    } else {
      packagePath = await this.resolvePackage(request.package);
      const parsed = packagePlatformFromName(path27.basename(packagePath));
      if (parsed === null) throw new Error(`\u4E0D\u662F dsh-mesh \u90E8\u7F72\u5305\uFF1A${path27.basename(packagePath)}`);
      os11 = parsed.os;
    }
    if (member !== void 0) {
      const identity = { id: member.id, name: member.name, ip: member.ip };
      if (test) assertTestUpgradeTarget(member, { packageOs: os11 });
      if (member.kind === "self" || member.id === "local") {
        return this.#startLocalJob({ member, packagePath, os: os11, mode, identity, ...acquire === null ? {} : { acquire } });
      }
      const deployRequest = await this.#memberDeployRequest(member, packagePath, os11);
      const download3 = mode === "install" || packageOnTarget !== null ? null : await this.#deployDownload(downloadRequest, member, all);
      const job2 = await this.#startEngineJob({
        request: {
          ...deployRequest,
          member: member.id,
          test,
          download: download3,
          ...packageOnTarget === null ? {} : { packageOnTarget },
          ...packageDescriptor === null ? {} : { packageDescriptor }
        },
        member: member.id,
        mode
      });
      return { ok: true, job: job2, member: identity, packagePath, layout: "pointer" };
    }
    if (host === "") throw new Error("host is required");
    if (test) throw new Error("\u6D4B\u8BD5\u5347\u7EA7\u9700\u8981\u4E00\u4E2A\u6210\u5458\uFF08\u8981\u5728\u6210\u5458\u7684\u5B89\u88C5\u4E0A\u6F14\u7EC3\uFF09\uFF0C\u4E0D\u80FD\u76F4\u63A5\u7ED9\u88F8 SSH \u4E3B\u673A");
    if (packageDescriptor !== null) throw new Error("latest tag \u9700\u8981\u4E00\u4E2A\u5DF2\u53D1\u73B0\u7684\u6210\u5458\uFF0C\u4E0D\u80FD\u76F4\u63A5\u7ED9\u88F8 SSH \u4E3B\u673A");
    const appRoot = os11 === "windows" ? "C:\\dsh-mesh" : "/opt/dsh-mesh";
    const download2 = mode === "install" || packageOnTarget !== null ? null : await this.#deployDownload(request, null, all);
    const job = await this.#startEngineJob({
      request: { host, package: packagePath, os: os11, appRoot, download: download2, ...packageOnTarget === null ? {} : { packageOnTarget } },
      member: null,
      mode
    });
    return { ok: true, job, member: null, packagePath, layout: "pointer" };
  }
  /**
   * Deploy one local package to a discovered member, without waiting.
   * Kept for the panel API, which returns a job id immediately.
   * @param {{member?: string, package?: string, release?: object, targetPackage?: object, mode?: 'install'|'upgrade'}} request member id/ip and package source.
   * @returns {Promise<object>} started deploy job.
   */
  async deployMember(request) {
    const result = await this.startDeploy({
      member: request.member,
      package: request.package,
      mode: request.mode,
      ...request.release === void 0 ? {} : { release: request.release },
      ...request.targetPackage === void 0 ? {} : { targetPackage: request.targetPackage }
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
   * Upgrade one member (or this machine) from a chosen deployment package.
   *
   * Same flow as a first deploy; the difference is that an installed member is
   * upgraded by the package instead of being installed from scratch, and the
   * panel labels the job as an upgrade.
   * @param {{member?: string, package?: string, release?: object, targetPackage?: object}} request member id/ip and package source.
   * @returns {Promise<object>} queued job.
   */
  async upgradeMember(request) {
    const result = await this.startDeploy({
      member: request.member,
      package: request.package,
      mode: "upgrade",
      ...request.release === void 0 ? {} : { release: request.release },
      ...request.targetPackage === void 0 ? {} : { targetPackage: request.targetPackage },
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
      logFile: path27.join(this.deployRoot, started.job.id, "deploy.log"),
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
   * Start one job for a member or a plain SSH host.
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
   * Start the local upgrade.
   *
   * The host runs the same in-place orchestrator as a member: the package's
   * `upgrade-local.mjs` moves the tree into `releases/<id>`, rewrites the
   * pointer and restarts the launcher-backed units.
   * @param {{member: object, packagePath: string, os: string, mode: 'install'|'upgrade', identity: object, acquire?: object}} input target.
   * @returns {Promise<object>} queued job and its layout.
   */
  async #startLocalJob(input) {
    const install = this.#localAppRoot();
    if (install === null) {
      throw new Error("\u672C\u673A\u6CA1\u6709\u53EF\u8BC6\u522B\u7684 dsh-mesh \u5B89\u88C5\u76EE\u5F55\uFF08\u627E\u4E0D\u5230 dsh-mesh.json\uFF09\uFF0C\u65E0\u6CD5\u5347\u7EA7\u672C\u673A");
    }
    if (input.os === "windows") {
      throw new Error("\u672C\u673A\u662F Linux \u7F51\u5173\uFF0C\u4E0D\u80FD\u5B89\u88C5 Windows \u90E8\u7F72\u5305");
    }
    const job = await this.#queueJob({
      mode: input.mode,
      member: "local",
      plan: null,
      request: {
        kind: "inplace",
        inplace: {
          package: input.packagePath,
          appRoot: install.appRoot,
          ...input.acquire === void 0 ? {} : { acquire: input.acquire }
        }
      },
      target: { host: "127.0.0.1", user: os10.userInfo().username, port: null, os: "linux", appRoot: install.appRoot },
      services: ["dsh-web-app.service", "dsh-web-gate.service", "dsh-wireguard-control.service"],
      packagePath: input.packagePath,
      release: typeof input.acquire?.name === "string" ? input.acquire.name : path27.basename(input.packagePath)
    });
    return { ok: true, job, member: input.identity, packagePath: input.packagePath, layout: "pointer" };
  }
  /**
   * Write one queued job directory and spawn its detached runner.
   * @param {{mode: string, member: string|null, plan: object|null, request: object, target?: object, services?: string[], packagePath?: string, release?: string}} job job input.
   * @returns {Promise<object>} queued job state.
   */
  async #queueJob(job) {
    const id = newJobId();
    const dir = path27.join(this.deployRoot, id);
    await mkdir15(dir, { recursive: true });
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const bytes = job.plan?.package?.bytes ?? (await stat13(job.packagePath).catch(() => null))?.size ?? 0;
    const state = {
      id,
      mode: job.mode,
      createdAt: now,
      updatedAt: now,
      member: job.member,
      target: job.plan === null ? job.target : { host: job.plan.host, user: job.plan.user ?? null, port: job.plan.port, os: job.plan.os, appRoot: job.plan.appRoot },
      release: job.plan?.release ?? job.release ?? "local",
      package: job.plan?.package?.path ?? job.packagePath ?? null,
      packageOnTarget: job.plan?.packageOnTarget === true,
      services: job.plan === null ? job.services ?? [] : job.plan.services.map((service) => service.name),
      status: "queued",
      phase: "starting",
      error: null,
      steps: initialDeploySteps({ test: job.plan?.test === true, os: job.plan?.os }),
      progress: { label: "\u542F\u52A8\u72EC\u7ACB\u5347\u7EA7\u8FDB\u7A0B", percent: 0, bytes: 0, totalBytes: bytes, speed: 0, indeterminate: false }
    };
    await writeDeployState(dir, state);
    const requestFile = jobPaths(dir).request;
    await writeFile15(requestFile, `${JSON.stringify({ ...job.request, id, member: job.member }, null, 2)}
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
    const script = path27.join(this.repositoryRoot, "code", "deploy", "runner.mjs");
    if (!existsSync14(script)) throw new Error(`deploy runner is missing: ${script}`);
    const node = process.execPath;
    const unit = `dsh-mesh-job-${id.replace(/^deploy-/u, "")}`;
    const systemdRun = ["/usr/bin/systemd-run", "/bin/systemd-run"].find((file) => existsSync14(file));
    if (systemdRun !== void 0 && process.platform === "linux" && process.getuid?.() === 0) {
      const result = await new Promise((resolve) => {
        const child2 = spawn7(systemdRun, [
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
    const child = spawn7(node, [script, "--job", dir], {
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
   * @returns {{appRoot: string, layout: 'pointer'}|null} install, or null in a source checkout.
   */
  #localAppRoot() {
    const inspect = (candidate2) => {
      try {
        if (existsSync14(path27.join(candidate2, "dsh-mesh.json")) && existsSync14(path27.join(candidate2, "releases"))) {
          return { appRoot: candidate2, layout: "pointer" };
        }
      } catch {
      }
      return null;
    };
    let candidate = path27.resolve(this.repositoryRoot, "..");
    for (let depth = 0; depth < 5; depth += 1) {
      const found = inspect(candidate);
      if (found !== null) return found;
      const parent = path27.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    candidate = path27.resolve(this.home);
    for (let depth = 0; depth < 5; depth += 1) {
      const found = inspect(candidate);
      if (found !== null) return found;
      const parent = path27.dirname(candidate);
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
    await writeFile15(path27.join(dir, "build.log"), "", "utf8");
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
    const entries = await readdir9(this.jobRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path27.join(this.jobRoot, entry.name);
      const state = await readState(dir).catch(() => null);
      if (state === null) continue;
      if (this.running.has(state.id) || state.status === "running" || state.status === "queued") continue;
      await rm15(dir, { recursive: true, force: true });
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
    const explicit = Array.isArray(request.release?.manifests) ? request.release.manifests : null;
    const manifests = [];
    if (explicit !== null) {
      for (const entry of explicit) {
        if (typeof entry === "string" && entry !== "") {
          let provider = "github";
          try {
            provider = /(?:^|\.)gitee\.com$/iu.test(new URL(entry).hostname) ? "gitee" : "github";
          } catch {
          }
          manifests.push({ provider, url: entry });
        } else if (entry !== null && typeof entry === "object" && typeof entry.url === "string" && entry.url !== "") {
          manifests.push({ provider: entry.provider === "gitee" ? "gitee" : "github", url: entry.url });
        }
      }
    } else {
      const releaseConfig = await loadReleaseConfig({ file: this.releaseConfigFile });
      const sources = latestManifestSources(releaseConfig);
      if (sources.github !== null) manifests.push({ provider: "github", url: sources.github });
      if (sources.gitee !== null) manifests.push({ provider: "gitee", url: sources.gitee });
    }
    const prefer = request.release?.prefer === "gitee" ? "gitee" : void 0;
    if (manifests.length === 0) return null;
    if (request.direct === true || request.proxyMember === "none") return { manifests, proxy: null, ...prefer === void 0 ? {} : { prefer } };
    const wanted = typeof request.proxyMember === "string" ? request.proxyMember.trim() : "";
    const linkProxy = resolveDeployLinkProxy({ links: await this.#directLinks(), target, wanted });
    if (linkProxy !== null) return { manifests, proxy: linkProxy, ...prefer === void 0 ? {} : { prefer } };
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
    if (proxyMember === null) return { manifests, proxy: null, ...prefer === void 0 ? {} : { prefer } };
    const plan = await this.#memberSshPlan(proxyMember);
    return {
      manifests,
      proxy: {
        kind: "ssh",
        host: plan.host,
        user: plan.user,
        port: plan.port,
        identityFile: plan.identityFile,
        appRoot: plan.appRoot,
        name: proxyMember.name
      },
      ...prefer === void 0 ? {} : { prefer }
    };
  }
  /**
   * Build the deployment request for a discovered member.
   * @param {object} member member snapshot.
   * @param {string} packagePath package file.
   * @param {'linux'|'windows'} os target OS.
   * @returns {Promise<object>} deploy request.
   */
  async #memberDeployRequest(member, packagePath, os11) {
    if (member.ip === "") throw new Error(`member ${member.id} has no VPN address`);
    let user = "root";
    let identityFile;
    const { state } = await readWireGuardState({ file: path27.join(this.home, "wireguard", "state.json") });
    const peer = state?.server?.peers?.find((candidate) => candidate?.ip === member.ip);
    if (peer !== void 0 && peer !== null) {
      if (typeof peer.sshUser === "string" && peer.sshUser !== "") user = peer.sshUser;
      if (typeof peer.publicKey === "string" && peer.publicKey !== "") {
        const digest = createHash8("sha256").update(peer.publicKey).digest("hex");
        const candidate = path27.join(this.home, "wireguard", "ssh", `${digest}.key`);
        if (existsSync14(candidate)) identityFile = candidate;
      }
    }
    const system = member.system;
    let appRoot = normalizeInstallRoot(system?.appRoot) || void 0;
    let serviceUser = typeof system?.user === "string" && system.user.trim() !== "" ? system.user.trim() : void 0;
    if (appRoot === void 0) {
      try {
        const detected = await this.deploy.inspectTarget({ host: member.ip, user, identityFile, os: os11 });
        appRoot = detected.appRoot;
        serviceUser = serviceUser ?? detected.serviceUser;
      } catch {
      }
    }
    if (appRoot === void 0 && typeof system?.home === "string" && system.home.trim() !== "") {
      const home = system.home.trim().replace(/[\\/]+$/u, "");
      appRoot = os11 === "windows" ? `${home}\\.dsh\\dsh-mesh` : `${home}/.dsh/dsh-mesh`;
    }
    if (appRoot === void 0) {
      const home = os11 === "windows" ? `C:\\Users\\${user}` : user === "root" ? "/root" : `/home/${user}`;
      appRoot = os11 === "windows" ? `${home}\\.dsh\\dsh-mesh` : `${home}/.dsh/dsh-mesh`;
    }
    return {
      host: member.ip,
      user,
      identityFile,
      os: os11,
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
   * Plan an SSH deployment without touching the network.
   * @param {object} request deploy options.
   * @returns {Promise<object>} plan.
   */
  async deployPlan(request) {
    return this.deploy.plan(request);
  }
  /**
   * Start an SSH deployment.
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
   * Cancel one queued or running deployment job and clean up after it.
   *
   * The job is owned by a detached runner, so this stops the runner (and, on
   * the member, only the staging/temp files that job made) instead of waiting
   * for the next phase. A job already switching services is refused.
   * @param {string} id job id.
   * @returns {Promise<object|null>} cancelled job, or null when unknown.
   */
  async cancelDeploy(id) {
    const job = await this.deploy.cancel(id);
    this.logLine(`mesh cancel ${typeof id === "string" ? id : ""}: ${job === null ? "unknown job" : job.status}`);
    return job;
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
   * put the member back without a shell. The local gateway rolls back through
   * `rollback-local.mjs`.
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
      throw new Error("\u672C\u673A\u56DE\u6EDA\u8BF7\u6267\u884C\uFF1Anode <\u5B89\u88C5\u6839>/rollback-local.mjs --root <\u5B89\u88C5\u6839>");
    }
    if (found.dsh !== true) {
      throw new Error(`\u6210\u5458 ${found.name} \u7684\u7F51\u5173\u6CA1\u6709\u5E94\u7B54\uFF0C\u65E0\u6CD5\u5728\u7EBF\u56DE\u6EDA\uFF1BSSH \u4E0A\u53BB\u6267\u884C code/deploy/cli.mjs rollback`);
    }
    const os11 = String(found.system?.platform ?? "").toLowerCase().startsWith("win") ? "windows" : "linux";
    const request = await this.#memberDeployRequest(found, "", os11);
    const rolled = await this.deploy.rollback({ ...request, os: os11, skipPackage: true });
    return { ok: true, job: rolled.job ?? rolled, member: found };
  }
  /**
   * Resolve and validate one job directory.
   * @param {string} id job id.
   * @returns {string} path.
   */
  _jobDir(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/u.test(id)) throw new Error("invalid job id");
    const dir = path27.resolve(this.jobRoot, id);
    if (!dir.startsWith(`${path27.resolve(this.jobRoot)}${path27.sep}`)) throw new Error("invalid job id");
    return dir;
  }
};

// code/shared/event-stream.mjs
import { mkdirSync, readdirSync, watch } from "node:fs";
import path28 from "node:path";
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
        const watcher = watch(path28.join(this.root, entry.name), { persistent: false }, (_event, file) => {
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
import path29 from "node:path";
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
      root: path29.join(service.dataDir, "build"),
      log,
      onChange: (dir, file) => handle("build", dir, file)
    }),
    new JobDirectoryWatcher({
      root: path29.join(service.dataDir, "deploy"),
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
        const path33 = url.pathname.slice(API_PREFIX.length) || "/";
        if (method === "GET" && path33 === "/status") {
          writeJson(response, 200, await service.status());
          return;
        }
        if (method === "GET" && path33 === "/members") {
          writeJson(response, 200, await service.members());
          return;
        }
        if (method === "GET" && path33 === "/member-tags") {
          writeJson(response, 200, { ok: true, tags: await service.memberTags() });
          return;
        }
        if (method === "GET" && path33 === "/member-conversations") {
          writeJson(response, 200, await service.memberConversations(url.searchParams.get("session") ?? ""));
          return;
        }
        if (method === "GET" && path33 === "/schedule") {
          if (scheduler === null) {
            writeJson(response, 503, { ok: false, error: { code: "unavailable", message: "\u5B9A\u65F6\u4EFB\u52A1\u8FD8\u6CA1\u6709\u542F\u52A8\u3002" } });
            return;
          }
          const member = url.searchParams.get("member") ?? "";
          writeJson(response, 200, { ok: true, schedule: scheduler.status(member === "" ? void 0 : member) });
          return;
        }
        if (method === "POST" && path33 === "/packages/delete") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.removePackage({ name: typeof body.name === "string" ? body.name : "" }));
          return;
        }
        if (method === "GET" && path33 === "/events") {
          hub.subscribe(request, response);
          return;
        }
        if (method === "GET" && path33 === "/jobs") {
          writeJson(response, 200, { ok: true, jobs: await service.jobs() });
          return;
        }
        if (method === "GET" && path33 === "/packages") {
          writeJson(response, 200, await service.packages());
          return;
        }
        if (method === "GET" && path33 === "/release/latest") {
          writeJson(response, 200, await service.latestRelease({
            refresh: url.searchParams.get("refresh") === "1"
          }));
          return;
        }
        if (method === "GET" && path33 === "/member-packages") {
          writeJson(response, 200, await service.memberPackages(url.searchParams.get("member") ?? ""));
          return;
        }
        if (method === "GET" && path33 === "/release") {
          writeJson(response, 200, await service.releaseSettings());
          return;
        }
        if (method === "GET" && path33 === "/deploy/jobs") {
          writeJson(response, 200, { ok: true, jobs: await service.deployJobs(30) });
          return;
        }
        if (method === "GET") {
          const deployRead = /^\/deploy\/([^/]+)(\/log)?$/u.exec(path33);
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
          const read = /^\/build\/([^/]+)(\/log)?$/u.exec(path33);
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
        if (method === "POST" && path33 === "/release") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.saveReleaseSettings(body));
          return;
        }
        if (path33 === "/deploy") {
          const body = await readJson2(request);
          const result = await service.deployMember({
            member: typeof body.member === "string" ? body.member : void 0,
            package: typeof body.package === "string" ? body.package : void 0,
            release: body.release !== null && typeof body.release === "object" ? body.release : void 0,
            targetPackage: body.targetPackage !== null && typeof body.targetPackage === "object" ? body.targetPackage : void 0
          });
          writeJson(response, 202, result);
          return;
        }
        if (path33 === "/session/promote") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.promoteSession(String(body.member ?? "")));
          return;
        }
        if (path33 === "/member-tags") {
          const body = await readJson2(request);
          writeJson(response, 200, await service.setMemberTag(
            typeof body.id === "string" ? body.id : "",
            typeof body.tag === "string" ? body.tag : ""
          ));
          return;
        }
        const clearLog = /^\/build\/([^/]+)\/log\/clear$/u.exec(path33);
        if (clearLog !== null) {
          writeJson(response, 200, await service.clearBuildLog(clearLog[1]));
          return;
        }
        if (path33 === "/build/logs/clear") {
          writeJson(response, 200, await service.clearFinishedBuilds());
          return;
        }
        if (path33 === "/deploy/cancel") {
          const body = await readJson2(request);
          const job = await service.cancelDeploy(typeof body.id === "string" ? body.id : "");
          if (job === null) {
            writeJson(response, 404, { ok: false, error: { code: "not_found", message: "Unknown deploy job." } });
            return;
          }
          writeJson(response, 200, { ok: true, job });
          return;
        }
        if (path33 === "/deploy/rollback") {
          const body = await readJson2(request);
          writeJson(response, 202, await service.rollbackMember({
            member: typeof body.member === "string" ? body.member : ""
          }));
          return;
        }
        if (path33 === "/upgrade" || path33 === "/test-upgrade") {
          const body = await readJson2(request);
          const request_ = {
            member: typeof body.member === "string" ? body.member : void 0,
            package: typeof body.package === "string" ? body.package : void 0,
            // The two extra package sources: the public latest tag and an
            // archive already on the target member.
            ...body.release !== null && typeof body.release === "object" ? { release: body.release } : {},
            ...body.targetPackage !== null && typeof body.targetPackage === "object" ? { targetPackage: body.targetPackage } : {},
            // Upgrade downloads default to the external proxy; the panel can
            // pick a different member or ask for a direct download.
            ...typeof body.proxyMember === "string" && body.proxyMember.trim() !== "" ? { proxyMember: body.proxyMember.trim() } : {},
            ...body.direct === true ? { direct: true } : {}
          };
          const test = path33 === "/test-upgrade" || body.test === true;
          writeJson(response, 202, test ? await service.testUpgradeMember(request_) : await service.upgradeMember(request_));
          return;
        }
        if (path33 === "/schedule") {
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
        if (path33 === "/build") {
          const body = await readJson2(request);
          const job = await service.startBuild({
            source: typeof body.source === "string" ? body.source : void 0,
            ref: typeof body.ref === "string" ? body.ref : void 0,
            targets: Array.isArray(body.targets) ? body.targets.filter((value) => typeof value === "string") : void 0,
            planOnly: body.planOnly === true,
            version: typeof body.version === "string" ? body.version : void 0,
            member: typeof body.member === "string" ? body.member : void 0,
            proxy: typeof body.proxy === "string" ? body.proxy : void 0,
            proxyMember: typeof body.proxyMember === "string" ? body.proxyMember : void 0,
            direct: body.direct === true,
            pullBack: typeof body.pullBack === "boolean" ? body.pullBack : void 0,
            autoUpgrade: typeof body.autoUpgrade === "boolean" ? body.autoUpgrade : void 0
          });
          writeJson(response, 202, { ok: true, job });
          return;
        }
        const resume = /^\/build\/([^/]+)\/resume$/u.exec(path33);
        if (resume !== null) {
          writeJson(response, 202, { ok: true, job: await service.resumeBuild(resume[1]) });
          return;
        }
        const match = /^\/build\/([^/]+)\/learn$/u.exec(path33);
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

// src/lib/member-context.mjs
import { randomUUID as randomUUID3 } from "node:crypto";

// src/lib/member-roster.mjs
import { readFile as readFile19 } from "node:fs/promises";
import path30 from "node:path";
var MEMBER_ROSTER_PATH = path30.join(".coder", "members", "all.md");
var FIELD = /^(工作区名称|身份|工作范围|备注)\s*[：:]\s*(.*)$/u;
var HOST_IN_NOTE = /(?:宿主|主机|host)\s*[：:]?\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[A-Za-z0-9][A-Za-z0-9._-]*)/iu;
function memberRosterHost(note) {
  if (typeof note !== "string" || note.trim() === "") return null;
  const match = HOST_IN_NOTE.exec(note);
  return match === null ? null : match[1];
}
function parseMemberRoster(text) {
  const members = [];
  let main = null;
  let current = null;
  const flush = () => {
    if (current === null) return;
    if (current.kind === "main") {
      main = { identity: current.identity, scope: current.scope };
    } else if (current.workspace !== null) {
      members.push({
        title: current.title,
        workspace: current.workspace,
        identity: current.identity,
        scope: current.scope,
        note: current.note,
        host: memberRosterHost(current.note)
      });
    }
    current = null;
  };
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    const heading = /^#\s+(.+?)\s*$/u.exec(line);
    if (heading !== null) {
      flush();
      const title = heading[1];
      current = {
        kind: title.startsWith("\u4E3B\u5BF9\u8BDD") ? "main" : "member",
        title,
        workspace: null,
        identity: null,
        scope: null,
        note: null
      };
      continue;
    }
    if (current === null) continue;
    const field = FIELD.exec(line);
    if (field === null) continue;
    const value = field[2].trim();
    if (value === "") continue;
    if (field[1] === "\u5DE5\u4F5C\u533A\u540D\u79F0") current.workspace = value;
    else if (field[1] === "\u8EAB\u4EFD") current.identity = value;
    else if (field[1] === "\u5DE5\u4F5C\u8303\u56F4") current.scope = value;
    else if (field[1] === "\u5907\u6CE8") current.note = value;
  }
  flush();
  return { main, members };
}
async function readMemberRoster(cwd) {
  const dir = typeof cwd === "string" ? cwd.trim() : "";
  if (dir === "") return null;
  let text;
  try {
    text = await readFile19(path30.join(dir, MEMBER_ROSTER_PATH), "utf8");
  } catch {
    return null;
  }
  const roster = parseMemberRoster(text);
  return roster.members.length === 0 ? null : roster;
}
function memberHostUsable(row) {
  if (row === null || typeof row !== "object") return false;
  return row.online !== false && row.dsh === true;
}
function hostNames(row) {
  return [row.id, row.name, row.ip, row.hostname].filter((value) => typeof value === "string" && value !== "");
}
function memberRosterGaps(roster, tasks, scopes = {}, options = {}) {
  if (roster === null || roster === void 0 || !Array.isArray(roster.members) || roster.members.length === 0) return null;
  const hosts = Array.isArray(options.hosts) ? options.hosts.filter((row) => row !== null && typeof row === "object") : [];
  const anyUsable = hosts.length === 0 ? true : hosts.some(memberHostUsable);
  const coveredWorkspaces = /* @__PURE__ */ new Set();
  const coveredIdentities = /* @__PURE__ */ new Set();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== "object" || task.archived === true) continue;
    const workspace = memberTaskWorkspace(task);
    if (workspace !== "" && workspace !== "unknown") coveredWorkspaces.add(workspace);
    const stored = scopes[String(task.conversationId ?? "")];
    const profile = stored !== void 0 ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task);
    if (typeof profile?.identity === "string" && profile.identity !== "") coveredIdentities.add(profile.identity);
  }
  const missing = [];
  const excused = [];
  for (const member of roster.members) {
    if (coveredWorkspaces.has(member.workspace)) continue;
    if (member.identity !== null && coveredIdentities.has(member.identity)) continue;
    if (member.host !== null && hosts.length > 0) {
      const row = hosts.find((candidate) => hostNames(candidate).includes(member.host));
      if (row === void 0) {
        excused.push({ member, reason: `\u5BBF\u4E3B ${member.host} \u4E0D\u5728\u7EC4\u7F51\u91CC` });
        continue;
      }
      if (!memberHostUsable(row)) {
        excused.push({ member, reason: `\u5BBF\u4E3B ${member.host} \u5F53\u524D\u4E0D\u53EF\u7528\uFF08\u79BB\u7EBF\u6216\u6CA1\u6709\u5728\u8FD0\u884C DSH\uFF09` });
        continue;
      }
      missing.push(member);
      continue;
    }
    if (!anyUsable) {
      excused.push({ member, reason: "\u6CA1\u6709\u53EF\u4EE5\u521B\u5EFA\u6210\u5458\u5BF9\u8BDD\u7684\u4E3B\u673A" });
      continue;
    }
    missing.push(member);
  }
  return { total: roster.members.length, missing, excused };
}
function formatMemberGapLines(gaps) {
  if (gaps === null || gaps === void 0) return [];
  const lines = [];
  if (Array.isArray(gaps.missing) && gaps.missing.length > 0) {
    lines.push(`[\u6210\u5458\u7F3A\u53E3] .coder/members/all.md \u8BB0\u5F55\u4E86 ${String(gaps.total)} \u4E2A\u6210\u5458\uFF0C\u5176\u4E2D ${String(gaps.missing.length)} \u4E2A\u8FD8\u6CA1\u6709\u6210\u5458\u5BF9\u8BDD\uFF08\u6BCF\u4E2A\u6210\u5458\u90FD\u5FC5\u987B\u6709\u4E00\u4E2A\uFF09\uFF1A`);
    for (const member of gaps.missing) {
      const identity = member.identity === null ? "" : `, "identity": ${JSON.stringify(member.identity)}`;
      lines.push(`- ${member.title}\uFF08\u5DE5\u4F5C\u533A ${member.workspace}${member.identity === null ? "" : `\uFF0C\u8EAB\u4EFD ${member.identity}`}\uFF09\u8FD8\u6CA1\u6709\u6210\u5458\u5BF9\u8BDD\uFF1Acall_member { "workspace": ${JSON.stringify(member.workspace)}${identity} }\uFF0C\u5DE5\u4F5C\u8303\u56F4\u6309\u540D\u518C\u91CC\u7684\u5199\u3002`);
    }
  }
  if (Array.isArray(gaps.excused) && gaps.excused.length > 0) {
    lines.push(`[\u6210\u5458\u7F3A\u53E3] \u540D\u518C\u91CC ${String(gaps.excused.length)} \u4E2A\u6210\u5458\u6682\u65F6\u5EFA\u4E0D\u4E86\u5BF9\u8BDD\uFF1A${gaps.excused.map((entry) => `${entry.member.title}\uFF08${entry.reason}\uFF09`).join("\u3001")}\u3002`);
  }
  return lines;
}

// src/lib/user-intent.mjs
var BUDGET_AUTH_MESSAGE_WINDOW = 8;
function userMessageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
}
function recentHumanUserMessages(agent, limit = BUDGET_AUTH_MESSAGE_WINDOW) {
  const session = agent?.session;
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];
  if (nodes.length === 0 || typeof session?.eventAt !== "function") return [];
  const messages = [];
  for (let index = nodes.length - 1; index >= 0 && messages.length < limit; index -= 1) {
    const event = session.eventAt(nodes[index]);
    if (event?.type !== "user/message") continue;
    const message = event.data;
    if (message?.role !== "user" || message?.source?.kind !== "user") continue;
    if (userMessageText(message) === "") continue;
    messages.push(message);
  }
  return messages;
}
function isBudgetAdjustmentText(text) {
  const value = typeof text === "string" ? text : "";
  if (!/(预算|call[\s_-]*member|callMemberBudget)/iu.test(value)) return false;
  if (/(不要|不用|别|无需|先不|暂不)[^。；;！!\n]{0,4}(调整|修改|设置|设定|改|调|提高|降低|增加|减少)/u.test(value)) {
    return false;
  }
  if (!/(调整|修改|设置|设定|改成|改为|设为|调到|调成|提到|提高到|降到|降低到|增加到|减少到|加到|定为)/u.test(value)) {
    return false;
  }
  return /\d/u.test(value);
}
function hasBudgetInstructionFromUser(agent, limit = BUDGET_AUTH_MESSAGE_WINDOW) {
  return recentHumanUserMessages(agent, limit).some((message) => isBudgetAdjustmentText(userMessageText(message)));
}

// src/lib/member-context.mjs
var MEMBER_STATUS_INTERVAL_MS = 6e4;
var LONG_JOB_WARN_MS = 6e4;
var HOST_CACHE_MS = 5 * 6e4;
var LONG_JOBS_MAX = 20;
var SELF_COMPRESS_COOLDOWN_MS = 10 * 6e4;
var MEMBER_CONTEXT_SOURCE = "member-context";
var DEFAULT_KEEP_PROMPT = "\u7EE7\u7EED";
function formatMemberPercent(value) {
  const amount = Number.isFinite(value) ? value : DEFAULT_COMPRESS_PERCENT;
  return `${amount >= 100 ? String(Math.round(amount)) : amount.toFixed(1).replace(/\.0$/u, "")}%`;
}
function agentCwd(agent) {
  const session = agent?.session;
  const cwd = session?.header?.cwd ?? session?.meta?.cwd ?? session?.cwd;
  return typeof cwd === "string" ? cwd.trim() : "";
}
function scopeForTask(task, scopes = {}) {
  const stored = scopes[String(task?.conversationId ?? "")];
  return stored !== void 0 ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task);
}
function formatMemberScopeMissingHint(tasks, scopes = {}) {
  const missing = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== "object") continue;
    const profile = scopeForTask(task, scopes);
    if (profile !== null && profile.identity !== null && profile.scope !== null) continue;
    const conversationId = String(task.conversationId ?? "");
    const member = String(task.member ?? "");
    const label = conversationId === "" ? member : member === "" ? conversationId : `${conversationId}\uFF08${member}\uFF09`;
    if (label !== "" && !missing.includes(label)) missing.push(label);
  }
  if (missing.length === 0) return "";
  return `\u8FD8\u6709\u6210\u5458\u4F1A\u8BDD\u6CA1\u6709\u8EAB\u4EFD/\u5DE5\u4F5C\u8303\u56F4\uFF1A${missing.join("\u3001")}\uFF1B\u4E0B\u6B21 call_member \u5E26 identity \u548C scope \u53C2\u6570\uFF0C\u6216\u7528 set_member_scope \u8BBE\u7F6E\u3002`;
}
function formatSelfScopeMissingHint(selfScope) {
  if (typeof selfScope?.identity === "string" && selfScope.identity.trim() !== "" && typeof selfScope?.scope === "string" && selfScope.scope.trim() !== "") return "";
  return "\u81EA\u8EAB\u8FD8\u6CA1\u6709\u8EAB\u4EFD/\u5DE5\u4F5C\u8303\u56F4\uFF1A\u7528 set_member_scope\uFF08\u7701\u7565 conversationId \u6216\u4F20 self\uFF09\u8BBE\u7F6E\u81EA\u8EAB\u8EAB\u4EFD\u548C\u5DE5\u4F5C\u8303\u56F4\u3002";
}
function formatJobDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1e3) : 0;
  if (total < 60) return `${String(total)} \u79D2`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${String(minutes)} \u5206\u949F` : `${String(minutes)} \u5206 ${String(seconds)} \u79D2`;
}
function formatSelfLine(selfId, selfScope) {
  const keep = selfScope?.keep === true;
  const keepPrompt = typeof selfScope?.keepPrompt === "string" && selfScope.keepPrompt !== "" ? selfScope.keepPrompt : DEFAULT_KEEP_PROMPT;
  const budget = formatCallMemberBudgetSettings(selfScope?.callMemberBudget);
  return `- \u8EAB\u4EFD\uFF1A${selfScope?.identity ?? "\u672A\u8BBE\u7F6E"}\uFF08\u81EA\u8EAB\uFF0C\u4F1A\u8BDD ${selfId === "" ? "unknown" : selfId}\uFF09\uFF1B\u5DE5\u4F5C\u8303\u56F4\uFF1A${selfScope?.scope ?? "\u672A\u8BBE\u7F6E"}\uFF1B\u4FDD\u6301\u76EE\u6807\uFF1A${keep ? `\u5F00\u542F\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u63D0\u793A\u8BED\u300C${keepPrompt}\u300D\uFF09` : "\u5173\u95ED\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09"}\uFF1B\u907F\u514D\u8017\u65F6\uFF1A${selfScope?.avoidLongJobs === true ? "\u5F00\u542F" : "\u5173\u95ED"}\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09\uFF1B\u9884\u7B97\u5BA1\u67E5\uFF1A${selfScope?.budgetAudit === true ? "\u5F00\u542F" : "\u5173\u95ED"}\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09\uFF1Bwait_member\uFF1A${selfScope?.waitMember === false ? "\u5173\u95ED" : "\u5F00\u542F"}\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09\uFF1Bturn/end \u81EA\u52A8\u538B\u7F29\uFF1A${selfScope?.compressOnTurnEnd === true ? "\u5F00\u542F" : "\u5173\u95ED"}\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09\uFF1Bcall_member \u9884\u7B97\uFF1A${budget}\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u6BCF\u4E2A\u5927\u9636\u6BB5\u5355\u72EC\u8BA1\uFF1B\u672A\u8BBE\u7F6E\u6309\u53C2\u4E0E\u6210\u5458\u6570 \xD7 2\uFF09\uFF1B\u538B\u7F29\u9608\u503C\uFF1A${formatMemberPercent(effectiveCompressPercent(selfScope))}`;
}
function formatMemberStatusSnapshot(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const selfId = String(options.selfId ?? "");
  const selfScope = options.selfScope ?? null;
  const scopes = options.scopes ?? {};
  const gapLines = Array.isArray(options.gaps) ? options.gaps : [];
  const stage = options.stage ?? null;
  const stageLines = stage === null ? list.length === 0 ? [] : ['- \u8FD8\u6CA1\u6709\u8BBE\u7F6E\u4EA7\u54C1\u9636\u6BB5\uFF1A\u7528 set_product_stage \u8BBE\u7F6E\u7248\u672C\u3001\u9636\u6BB5\u4E0E\u76EE\u6807\uFF08\u5982 { "stage": "A" }\uFF09\u3002'] : formatProductStageLines(stage, list, scopes, {
    callMemberBudget: selfScope?.callMemberBudget,
    statuses: false
  });
  const lines = [
    ...formatProductStageDefinitions(),
    ...stageLines,
    formatSelfLine(selfId, selfScope),
    ...gapLines
  ];
  const longJobs = Array.isArray(options.longJobs) ? options.longJobs : [];
  if (longJobs.length > 0) {
    lines.push(
      `[\u8017\u65F6\u63D0\u9192] \u8DDD\u4E0A\u4E00\u6B21\u5FEB\u7167\u6709 ${String(longJobs.length)} \u4E2A job \u8017\u65F6\u8D85\u8FC7 1 \u5206\u949F\uFF1A`,
      ...longJobs.map((job) => {
        const kind = typeof job?.kind === "string" && job.kind !== "" ? `${job.kind}\uFF1A` : "";
        const label = typeof job?.label === "string" && job.label !== "" ? job.label : String(job?.jobId ?? "job");
        return `- ${kind}${label}\uFF08\u8017\u65F6 ${formatJobDuration(job?.durationMs)}\uFF09`;
      }),
      "\u63A8\u8350\u628A\u8FD9\u7C7B\u8017\u65F6\u5DE5\u4F5C\u4EA4\u7ED9\u6210\u5458\u5BF9\u8BDD\u6267\u884C\uFF1A\u7528 call_member \u6307\u5B9A\u6210\u5458\u548C\u5DE5\u4F5C\u533A\uFF0C\u907F\u514D\u4E3B\u5BF9\u8BDD\u88AB\u957F\u4EFB\u52A1\u5360\u7528\u3002"
    );
  }
  const selfHint = formatSelfScopeMissingHint(selfScope);
  if (selfHint !== "") lines.push(selfHint);
  return lines.join("\n");
}
function createMemberContext({
  ctx,
  memberTasks,
  service,
  log = () => {
  },
  intervalMs = MEMBER_STATUS_INTERVAL_MS,
  now = () => Date.now()
}) {
  const lastInjection = /* @__PURE__ */ new Map();
  const turns = /* @__PURE__ */ new Map();
  const keepPending = /* @__PURE__ */ new Set();
  const longJobs = /* @__PURE__ */ new Map();
  const selfCompressAt = /* @__PURE__ */ new Map();
  const disposers = [];
  let closed = false;
  async function readScopes() {
    if (typeof service?.memberScopes !== "function") return {};
    return await service.memberScopes().catch(() => ({}));
  }
  async function stageFor(agent) {
    if (typeof service?.productStage !== "function") return null;
    const cwd = agentCwd(agent);
    if (cwd === "") return null;
    return await service.productStage(cwd).catch(() => null);
  }
  let hostsCache = { at: 0, rows: null };
  async function memberHosts() {
    if (hostsCache.rows !== null && now() - hostsCache.at < HOST_CACHE_MS) return hostsCache.rows;
    const read = typeof service?.members === "function" ? service.members : null;
    if (read === null) return null;
    const snapshot = await read.call(service).catch(() => null);
    if (snapshot === null || typeof snapshot !== "object") return null;
    const rows = [snapshot.local, ...Array.isArray(snapshot.members) ? snapshot.members : []].filter((row) => row !== null && row !== void 0 && typeof row === "object");
    hostsCache = { at: now(), rows };
    return rows;
  }
  async function rosterGaps(agent, tasks, scopes) {
    const cwd = agentCwd(agent);
    if (cwd === "") return null;
    const roster = await readMemberRoster(cwd).catch(() => null);
    if (roster === null) return null;
    const covered = /* @__PURE__ */ new Set();
    for (const task of tasks) {
      const workspace = typeof task?.workspace === "string" ? task.workspace.trim() : "";
      if (workspace !== "" && workspace !== "unknown") covered.add(workspace);
    }
    const uncovered = roster.members.some((member) => !covered.has(member.workspace));
    const hosts = uncovered ? await memberHosts() : [];
    return memberRosterGaps(roster, tasks, scopes, { hosts: Array.isArray(hosts) ? hosts : [] });
  }
  async function snapshotFor(agent) {
    const sessionId = String(agent?.session?.id ?? agent?.id ?? "");
    if (sessionId === "") return null;
    const at = now();
    const last = lastInjection.get(sessionId);
    if (typeof last === "number" && Number.isFinite(last) && at >= last && at - last < intervalMs) return null;
    const [running, stage] = await Promise.all([
      memberTasks.inFlightForOrigin(sessionId),
      stageFor(agent)
    ]);
    if (!Array.isArray(running)) return null;
    const [tasks, scopes] = await Promise.all([
      memberTasks.listForOrigin(sessionId),
      readScopes()
    ]);
    const selfScope = scopes[sessionId] ?? null;
    const taken = takeLongJobs(sessionId, at, last);
    const hintJobs = selfScope?.avoidLongJobs === true ? taken : [];
    const gaps = await rosterGaps(agent, tasks, scopes);
    const gapLines = formatMemberGapLines(gaps);
    if (running.length === 0 && hintJobs.length === 0 && gapLines.length === 0 && stage === null) return null;
    if (stage !== null) {
      void maybeAuditBudget(agent, sessionId, stage, tasks, scopes, selfScope).catch((error) => {
        log(`budget audit skipped: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return {
      text: formatMemberStatusSnapshot(tasks, { now: at, selfId: sessionId, selfScope, scopes, longJobs: hintJobs, gaps: gapLines, stage }),
      at
    };
  }
  async function maybeAuditBudget(agent, sessionId, stage, tasks, scopes, selfScope) {
    if (closed || isMemberSession(sessionId)) return;
    if (selfScope?.budgetAudit !== true) return;
    if (typeof service?.claimBudgetAudit !== "function") return;
    const budget = callMemberBudgetFor(selfScope?.callMemberBudget, stage.stage) ?? defaultCallMemberBudget(stage, tasks, scopes);
    if (countCallMemberReplies(stage, tasks) < budget) return;
    const cwd = agentCwd(agent);
    if (cwd === "") return;
    const claim = await service.claimBudgetAudit({ cwd, now: now() }).catch(() => null);
    if (claim === null) return;
    if (closed) return;
    const subagents = typeof ctx?.get === "function" ? ctx.get("subagents") : void 0;
    if (subagents === void 0 || subagents === null || typeof subagents.startActivation !== "function") {
      await service.releaseBudgetAudit?.({ cwd, lastAt: claim.lastAt }).catch(() => {
      });
      return;
    }
    try {
      await subagents.startActivation({
        provider: "fork",
        label: "\u9884\u7B97\u5BA1\u67E5",
        prompt: [{ type: "text", text: budgetAuditPrompt(agent, stage, tasks, scopes, selfScope) }],
        parent: agent,
        delivery: "parent",
        // The audit must outlive this pre-step: it is an independent check, not
        // part of the step's cancellable work.
        signal: new AbortController().signal
      });
      log(`budget audit started for ${sessionId}: ${stage.stage} round ${String(stage.round)} (${String(claim.count)} in this stage)`);
    } catch (error) {
      await service.releaseBudgetAudit?.({ cwd, lastAt: claim.lastAt }).catch(() => {
      });
      log(`budget audit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function budgetAuditPrompt(agent, stage, tasks, scopes, selfScope) {
    const stageBlock = formatProductStageLines(stage, tasks, scopes, {
      callMemberBudget: selfScope?.callMemberBudget,
      statuses: true
    }).join("\n");
    const recent = recentHumanUserMessages(agent, 6).map((message) => `- ${userMessageText(message).slice(0, 400)}`).join("\n");
    return [
      "\u4F60\u662F\u72EC\u7ACB\u7684\u9884\u7B97\u5BA1\u67E5\u5B50\u4EE3\u7406\u3002\u4E3B\u5BF9\u8BDD\u7684 call_member \u672C\u8F6E\u9884\u7B97\u5DF2\u7ECF\u8017\u5C3D\uFF0C\u8BF7\u53EA\u505A\u5BA1\u67E5\uFF1A\u4E0D\u8981\u4FEE\u6539\u6587\u4EF6\uFF0C\u4E0D\u8981\u8C03\u7528 call_member / set_member_scope / set_product_stage\u3002",
      "",
      "[\u5F53\u524D\u9636\u6BB5]",
      stageBlock,
      "",
      "[\u6700\u8FD1\u7528\u6237\u6D88\u606F]",
      recent === "" ? "- \uFF08\u6CA1\u6709\u53EF\u7528\u7684\u7528\u6237\u6D88\u606F\uFF09" : recent,
      "",
      "\u8BF7\u68C0\u67E5\uFF1A",
      "1. \u4E3B\u5BF9\u8BDD\u662F\u5426\u6309\u5F53\u524D\u4EA7\u54C1\u9636\u6BB5\u5DE5\u4F5C\uFF1B",
      "2. \u662F\u5426\u505A\u4E86\u8D85\u51FA\u5F53\u524D\u9636\u6BB5\u7684\u5DE5\u4F5C\uFF1B",
      "3. \u9884\u7B97\u4E3A\u4EC0\u4E48\u8017\u5C3D\uFF1A\u91CD\u590D\u6D3E\u6D3B\u3001\u4E0E\u9636\u6BB5\u65E0\u5173\u7684\u8C03\u7528\u3001\u6210\u5458\u7A7A\u8F6C\u3001\u65E0\u610F\u4E49\u8F6E\u8BE2\u7B49\uFF1B",
      "4. \u5982\u679C\u4E3B\u5BF9\u8BDD\u7684\u4F7F\u7528\u4E0D\u5408\u7406\uFF0C\u8F93\u51FA\u300C[\u9884\u7B97\u5BA1\u67E5] \u8B66\u544A\uFF1A\u2026\u300D\u5E76\u7ED9\u51FA\u660E\u786E\u7684\u4E0B\u4E00\u6B65\u5EFA\u8BAE\uFF1B",
      "   \u5982\u679C\u672A\u53D1\u73B0\u95EE\u9898\uFF0C\u53EA\u8F93\u51FA\u4E00\u884C\u300C[\u9884\u7B97\u5BA1\u67E5] \u672A\u53D1\u73B0\u4E3B\u5BF9\u8BDD\u6EE5\u7528\u9884\u7B97\u300D\u3002",
      "\u53EA\u8F93\u51FA\u7ED3\u8BBA\u4E0E\u5EFA\u8BAE\uFF0C\u4E0D\u8981\u590D\u8FF0\u5BF9\u8BDD\u3002"
    ].join("\n");
  }
  function recordLongJob(sessionId, job) {
    if (!(job.durationMs > LONG_JOB_WARN_MS)) return;
    const list = longJobs.get(sessionId) ?? [];
    const label = String(job.label ?? "").replace(/\s+/gu, " ").trim().slice(0, 120);
    list.push({
      jobId: typeof job.jobId === "string" ? job.jobId : "",
      kind: typeof job.kind === "string" ? job.kind : "",
      label: label === "" ? String(job.jobId ?? "job") : label,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs
    });
    if (list.length > LONG_JOBS_MAX) list.splice(0, list.length - LONG_JOBS_MAX);
    longJobs.set(sessionId, list);
  }
  function takeLongJobs(sessionId, at, last) {
    const list = longJobs.get(sessionId);
    if (!Array.isArray(list) || list.length === 0) return [];
    longJobs.delete(sessionId);
    const floor = typeof last === "number" && Number.isFinite(last) ? last : 0;
    return list.filter((job) => Number.isFinite(job.finishedAt) && job.finishedAt <= at && job.finishedAt > floor);
  }
  async function handler(payload, next) {
    const decision = await next();
    if (closed || decision?.kind === "reject" || payload?.signal?.aborted) return decision;
    try {
      const snapshot = await snapshotFor(payload?.agent);
      if (snapshot === null) return decision;
      const message = {
        id: randomUUID3(),
        role: "user",
        content: [{ type: "text", text: snapshot.text }],
        // Deliberately not `user`: this is injected context, not input the
        // human sent, and the source keeps it distinguishable in the request.
        source: {
          kind: MEMBER_CONTEXT_SOURCE,
          form: "snapshot",
          sections: [{ name: MEMBER_CONTEXT_SOURCE, text: snapshot.text }]
        }
      };
      lastInjection.set(String(payload.agent?.session?.id ?? payload.agent?.id ?? ""), snapshot.at);
      return { ...decision, messages: [...Array.isArray(decision.messages) ? decision.messages : [], message] };
    } catch (error) {
      log(`member status context skipped: ${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
  }
  async function maybeKeep(sessionId, turn) {
    if (closed) return;
    const scopes = await readScopes();
    if (closed || turns.get(sessionId) !== turn) return;
    if ((scopes[sessionId] ?? null)?.keep !== true) return;
    const running = await memberTasks.inFlightForOrigin(sessionId).catch(() => null);
    if (!Array.isArray(running)) return;
    if (running.length > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (closed || turns.get(sessionId) !== turn) return;
    const agent = typeof ctx?.get === "function" ? ctx.get("agents")?.get(sessionId) : void 0;
    if (agent === void 0 || agent === null || agent.status !== "idle") return;
    const selfScope = scopes[sessionId] ?? null;
    const prompt = typeof selfScope?.keepPrompt === "string" && selfScope.keepPrompt !== "" ? selfScope.keepPrompt : DEFAULT_KEEP_PROMPT;
    try {
      agent.followup({
        id: randomUUID3(),
        role: "user",
        content: [{ type: "text", text: prompt }],
        source: { kind: MEMBER_CONTEXT_SOURCE, form: "keep" }
      });
      keepPending.add(sessionId);
      log(`member keep push to ${sessionId}: no member conversation is running, prompt "${prompt}"`);
    } catch (error) {
      log(`member keep push failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function maybeSelfCompress(sessionId, turn) {
    if (closed || isMemberSession(sessionId)) return;
    const scopes = await readScopes();
    if (closed || turns.get(sessionId) !== turn) return;
    const selfScope = scopes[sessionId] ?? null;
    if (selfScope?.compressOnTurnEnd !== true) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (closed || turns.get(sessionId) !== turn) return;
    const get = typeof ctx?.get === "function" ? (name) => ctx.get(name) : () => void 0;
    const agent = get("agents")?.get(sessionId);
    if (agent === void 0 || agent === null || agent.status !== "idle") return;
    const meter = get("tokenMeter");
    const compaction = get("compaction");
    if (typeof meter?.contextPressure !== "function" || typeof compaction?.compactNow !== "function") return;
    const pressure = meter.contextPressure(agent.session);
    const used = pressure?.pressureTokens;
    const capacity = pressure?.contextWindow;
    if (!Number.isFinite(used) || !Number.isFinite(capacity) || capacity <= 0) return;
    const percent = Math.min(100, Math.round(used / capacity * 100));
    const threshold = effectiveCompressPercent(selfScope);
    if (percent <= threshold) return;
    const last = selfCompressAt.get(sessionId) ?? 0;
    if (now() - last < SELF_COMPRESS_COOLDOWN_MS) return;
    selfCompressAt.set(sessionId, now());
    try {
      await compaction.compactNow(agent, new AbortController().signal);
      log(`self compaction for ${sessionId}: ${formatMemberPercent(percent)} > ${formatMemberPercent(threshold)}`);
    } catch (error) {
      log(`self compaction skipped for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function onEvent(session, event) {
    if (closed || session === void 0 || event === void 0) return;
    const sessionId = String(session.id ?? "");
    if (sessionId === "" || isMemberSession(sessionId)) return;
    if (event.type === "job/settled") {
      const data = event.data ?? {};
      const startedAt = Number(data.startedAt);
      const finishedAt = Number.isFinite(Number(data.finishedAt)) ? Number(data.finishedAt) : Number(event.time);
      if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return;
      recordLongJob(sessionId, {
        jobId: data.jobId,
        kind: data.kind,
        label: data.label,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt
      });
      return;
    }
    if (event.type === "turn/start") {
      turns.set(sessionId, Number.isSafeInteger(event.data?.turn) ? event.data.turn : null);
      return;
    }
    if (event.type !== "turn/end") return;
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : turns.get(sessionId) ?? null;
    turns.set(sessionId, turn);
    const nudged = keepPending.delete(sessionId);
    void (async () => {
      await maybeSelfCompress(sessionId, turn);
      if (!nudged) await maybeKeep(sessionId, turn);
    })().catch((error) => {
      log(`member turn-end check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (typeof ctx?.on === "function") {
    disposers.push(ctx.on("agent/pre-step", handler, { prepend: true }));
    disposers.push(ctx.on("session/event", onEvent));
    disposers.push(ctx.on("session/disposed", (session) => {
      const id = String(session?.id ?? "");
      if (id === "") return;
      lastInjection.delete(id);
      turns.delete(id);
      keepPending.delete(id);
      longJobs.delete(id);
      selfCompressAt.delete(id);
    }));
  }
  return {
    handler,
    onEvent,
    lastInjection,
    turns,
    keepPending,
    selfCompressAt,
    dispose() {
      closed = true;
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.();
        } catch {
        }
      }
      lastInjection.clear();
      turns.clear();
      keepPending.clear();
      longJobs.clear();
      selfCompressAt.clear();
    }
  };
}

// src/lib/tools.mjs
function callMemberBudgetSchema() {
  return {
    type: "object",
    description: "\u6BCF\u4E2A\u5927\u9636\u6BB5\u5355\u72EC\u7684 call_member \u9884\u7B97\uFF1B\u53EF\u53EA\u7ED9\u8981\u8BBE\u7684\u9636\u6BB5\uFF0C\u6574\u6570 1\u2013999\uFF0C\u6CA1\u6709\u7EDF\u4E00\u503C\uFF1B\u6CA1\u8BBE\u7F6E\u7684\u9636\u6BB5\u9ED8\u8BA4\u4E3A\u53C2\u4E0E\u6210\u5458\u6570 \xD7 2\u3002\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\u3002",
    properties: {
      A: { type: "integer", minimum: 1, maximum: 999, description: "A \u8BA1\u5212\u4E0E\u76EE\u6807\u9636\u6BB5\u6BCF\u8F6E\u7684 call_member \u9884\u7B97\u3002" },
      B: { type: "integer", minimum: 1, maximum: 999, description: "B \u5F00\u53D1\u4E0E\u6D4B\u8BD5\u9636\u6BB5\u6BCF\u8F6E\u7684 call_member \u9884\u7B97\u3002" },
      C: { type: "integer", minimum: 1, maximum: 999, description: "C \u4EA7\u54C1\u7ECF\u7406\u4F7F\u7528\u9636\u6BB5\u6BCF\u8F6E\u7684 call_member \u9884\u7B97\u3002" },
      D: { type: "integer", minimum: 1, maximum: 999, description: "D \u4E1A\u52A1\u4ECB\u5165\u9636\u6BB5\u6BCF\u8F6E\u7684 call_member \u9884\u7B97\u3002" }
    },
    minProperties: 1,
    additionalProperties: false
  };
}
var STOP_ALL_MEMBER_PROMPT = "\u8BF7\u5C3D\u5FEB\u505C\u6B62\u5DE5\u4F5C\uFF0C\u6536\u655B\u624B\u4E2D\u5DE5\u4F5C\uFF0C\u8BE5\u63D0\u4EA4\u63A8\u9001\u7684\u5C3D\u5FEB\u5904\u7406\u3002";
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
  void memberTasks.init().catch((error) => {
    ctx.logger?.warn?.(`mesh: member task recovery skipped: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    ctx.effect(() => () => memberTasks.dispose(), "mesh member tasks");
  } catch {
  }
  const memberContext = createMemberContext({
    ctx,
    memberTasks,
    service,
    log: (line) => ctx.logger?.info?.(`mesh: ${line}`)
  });
  try {
    ctx.effect(() => () => memberContext.dispose(), "mesh member status context");
  } catch {
  }
  const callMemberDefinition = {
    name: "call_member",
    description: [
      "\u628A\u4EFB\u52A1\u4EA4\u7ED9\u53E6\u4E00\u4E2A WireGuard \u6210\u5458\u4E0A\u7684 DSH \u5BF9\u8BDD\u3002",
      "",
      "\u6CA1\u6709 `conversationId`\uFF1A\u5728\u6210\u5458 B \u4E0A\u65B0\u5EFA\u5BF9\u8BDD\uFF0C\u7ACB\u5373\u8FD4\u56DE\u4F1A\u8BDDid\uFF1B\u4E0D\u4F1A\u540C\u6B65\u7B49\u5F85\u3002",
      "\u6709 `conversationId`\uFF1A\u628A\u8FD9\u6761\u6D88\u606F\u7EE7\u7EED\u6295\u9012\u5230\u90A3\u4E2A\u5DF2\u6709\u5BF9\u8BDD\uFF0C\u7ACB\u5373\u8FD4\u56DE\uFF1B\u4E0D\u4F1A\u540C\u6B65\u7B49\u5F85\u3002",
      "\u76EE\u6807\u5BF9\u8BDD\u6B63\u5728\u8FD0\u884C\u65F6\uFF0C\u6D88\u606F\u7528 steer \u76F4\u63A5\u63D2\u5165\u5F53\u524D turn\uFF0C\u4E0D\u7B49\u5B83\u7ED3\u675F\uFF1B\u7A7A\u95F2\u65F6\u6309\u666E\u901A followup \u5F00\u4E00\u8F6E\u3002",
      "\u4F1A\u8BDDid\uFF08conversationId\uFF09\u662F\u8DE8\u8FDB\u7A0B\u7684\u7EE7\u7EED\u6295\u9012\u51ED\u636E\uFF1A\u91CD\u65B0\u542F\u52A8\u540E\u3001\u6216\u4E0D\u662F\u672C\u673A\u53D1\u8D77\u7684\u5BF9\u8BDD\uFF0C",
      "\u53EA\u8981\u77E5\u9053\u4F1A\u8BDDid\uFF0C\u914D\u4E0A member \u5C31\u80FD\u7EE7\u7EED\uFF1B\u672C\u673A\u5DF2\u8DDF\u8E2A\u8BE5\u5BF9\u8BDD\u65F6 member \u53EF\u4EE5\u7701\u7565\u3002",
      "\u7EE7\u7EED\u5DF2\u6709\u5BF9\u8BDD\u65F6\uFF0C\u6295\u9012\u524D\u4F1A\u6309\u8BE5\u4F1A\u8BDD\u7684\u538B\u7F29\u9608\u503C\uFF08`set_member_scope` \u7684 `compressPercent`\uFF0C\u9ED8\u8BA4 35%\uFF09\u68C0\u67E5\u4E0A\u4E0B\u6587\u5360\u6BD4\uFF1A",
      "\u8D85\u8FC7\u9608\u503C\u4E14\u76EE\u6807\u7A7A\u95F2\u5C31\u5148\u8BA9\u6210\u5458\u538B\u7F29\u4E0A\u4E0B\u6587\u518D\u6295\u9012\uFF1B\u76EE\u6807\u8FD8\u5728\u8FD0\u884C\u5C31\u8DF3\u8FC7\u538B\u7F29\u3001\u76F4\u63A5\u628A\u6D88\u606F steer \u8FDB\u53BB\u3002\u538B\u7F29\u9608\u503C\u53EA\u6309\u4F1A\u8BDD\u8BBE\u7F6E\uFF0C\u4E0D\u63A5\u53D7\u6BCF\u6B21\u8C03\u7528\u5355\u72EC\u6307\u5B9A\u3002",
      "\u76EE\u6807\u6210\u5458\u6B63\u5728\u90E8\u7F72/\u5347\u7EA7\uFF08\u5305\u62EC\u81EA\u52A8\u5347\u7EA7\u524D\u5341\u5206\u949F\u7684\u51C6\u5907\u671F\uFF09\u65F6\uFF0Ccall_member \u76F4\u63A5\u8FD4\u56DE ok:false\uFF0C\u4E0D\u521B\u5EFA\u4E5F\u4E0D\u6295\u9012\uFF1A\u5347\u7EA7\u4F1A\u91CD\u542F\u76EE\u6807\u6210\u5458\u7684 DSH\uFF0C\u73B0\u5728\u6D3E\u53D1\u7684\u6D88\u606F\u4F1A\u4E22\u3002",
      "\u7B49\u5347\u7EA7\u7ED3\u675F\u540E\u518D\u7528\u540C\u4E00\u4E2A conversationId \u7EE7\u7EED\u3002",
      "\u8981\u6295\u9012\u7684\u6D88\u606F\u8D85\u8FC7 4.8 \u4E07\u5B57\u7B26\u65F6\uFF0C\u6B63\u6587\u4F1A\u5199\u5230\u6210\u5458\u672C\u673A\u7684\u4E34\u65F6\u6587\u4EF6\uFF0C\u6295\u9012\u5185\u5BB9\u6539\u6210\u300C\u8BFB\u53D6\u8BE5\u6587\u4EF6\u300D\u7684\u8BF4\u660E\uFF1B\u8FD4\u56DE\u503C data.messageSpill \u662F\u6587\u4EF6\u8DEF\u5F84\u3002",
      "\u4E00\u4E2A\u5DE5\u4F5C\u533A\u53EA\u5141\u8BB8\u4E00\u4E2A\u5BF9\u8BDD\uFF08\u65B0\u5EFA\u65F6\u751F\u6548\uFF09\uFF1A\u76EE\u6807\u5DE5\u4F5C\u533A\u76EE\u5F55\u91CC\u5DF2\u7ECF\u6709\u5BF9\u8BDD\u2014\u2014\u4E0D\u7BA1\u5B83\u662F\u8FDB\u884C\u4E2D\u3001\u7A7A\u95F2\u3001\u5F02\u5E38\u4E2D\u6B62\u8FD8\u662F\u51FA\u9519\u2014\u2014",
      "\u521B\u5EFA\u4F1A\u8FD4\u56DE 409 workspace_occupied\uFF0C\u5E76\u7ED9\u51FA\u90A3\u6761\u5BF9\u8BDD\u7684\u4F1A\u8BDDid\uFF1B\u8FD9\u65F6\u4E0D\u8981\u65B0\u5EFA\uFF0C\u76F4\u63A5 call_member \u5E26 conversationId \u7EE7\u7EED\u5B83\u3002",
      "\u8981\u7EE7\u7EED\u5DF2\u6709\u5BF9\u8BDD\u4E0D\u4F1A\u89E6\u53D1\u8FD9\u4E2A\u62E6\u622A\uFF1B\u8981\u5E76\u884C\u5DE5\u4F5C\u5C31\u6362\u4E00\u4E2A workspace \u540D\uFF08\u6216\u65B0\u5EFA\u5DE5\u4F5C\u533A\uFF09\u3002",
      "\u8FD4\u56DE\u503C\u5E26\u5F53\u524D\u4F1A\u8BDDid\uFF0C\u4EE5\u53CA\u672C\u5BF9\u8BDD\u8DDF\u8E2A\u7684\u6240\u6709\u6210\u5458\u4F1A\u8BDD\uFF08\u4F1A\u8BDDid\u3001\u8FDB\u884C\u4E2D/\u7A7A\u95F2/\u5F02\u5E38\u4E2D\u6B62\u3001\u5DE5\u4F5C\u533A\u3001\u8F6E\u6B21\uFF09\u3002",
      '\u7528 wait_member \u7B49\u7ED3\u679C\uFF08\u63A8\u8350 all: true\uFF09\uFF1Await_member { "all": true } \u7B49\u6240\u6709\u8FDB\u884C\u4E2D\u7684\u4F1A\u8BDD\uFF0C',
      "\u4EFB\u610F\u4E00\u4E2A\u5148\u8FD4\u56DE\u5C31\u7ACB\u523B\u8FD4\u56DE\uFF1B\u4E5F\u53EF\u4EE5\u53EA\u7528 conversationIds \u6307\u5B9A\u4F1A\u8BDD\u3002\u6210\u5458\u6BCF\u7ED3\u675F\u4E00\u8F6E\u56DE\u7B54\u5C31\u8FD4\u56DE\u4E00\u6B21\uFF0C",
      "\u53EA\u6709 state=done \u624D\u662F\u6574\u6BB5\u4EFB\u52A1\u7684\u6700\u7EC8\u7ED3\u679C\u3002",
      "\u5982\u679C\u4E0D\u518D\u7EE7\u7EED wait\uFF1A\u5BF9\u8BDD\u5B8C\u6210\uFF08\u6216\u5931\u8D25/\u4E2D\u65AD\uFF09\u540E\uFF0C3 \u79D2\u5185\u6CA1\u6709 wait_member \u53D6\u8D70\u7ED3\u679C\uFF0C",
      "\u63D2\u4EF6\u53EA\u6295\u9012\u5C1A\u672A\u53D6\u8D70\u7684\u56DE\u590D\uFF1B\u5DF2\u7ECF\u53D6\u8D70\u7684\u7ED3\u679C\u4E0D\u4F1A\u91CD\u590D\u6295\u9012\u3002",
      "\u4E3B\u5BF9\u8BDD\u5F53\u65F6\u6B63\u5728\u6267\u884C turn \u65F6\uFF0C\u8FD9\u6761\u7ED3\u679C\u4F1A\u76F4\u63A5\u63D2\u5165\u5F53\u524D turn\uFF08agent.steer\uFF09\uFF0C\u4E0D\u7B49 turn \u7ED3\u675F\u3002",
      "\u65B0\u5EFA\u5BF9\u8BDD\u524D\u4F1A\u6309\u7EC4\u7F51\u76F4\u8FDE\u914D\u7F6E\u627E\u5230\u76EE\u6807\u6210\u5458\u7684\u672C\u5730\u4EE3\u7406\u7AEF\u53E3\uFF0C\u7528 SSH \u5728\u76EE\u6807\u6210\u5458\u4E0A\u8DD1 mjs \u63A2\u9488\u5B9E\u6D4B\u5176\u5EF6\u8FDF\u548C\u4E0B\u884C\u5E26\u5BBD\uFF0C",
      "\u628A\u4E00\u884C\u7ED3\u679C\u3001\u4EE3\u7406\u7AEF\u53E3\u548C hub \u7684 git token \u6CE8\u5165\u76EE\u6807\u4F1A\u8BDD\uFF08\u6CA1\u6709\u76F4\u8FDE\u914D\u7F6E\u5C31\u4E0D\u62A5\u51FA\u7F51\uFF09\uFF1B\u5E76\u7981\u7528\u8BE5\u4F1A\u8BDD\u7684 ask_user_question\uFF0C",
      "\u6BCF\u6B21\u6295\u9012\u524D\u8FD8\u4F1A\u5BF9\u5F53\u524D live agent \u91CD\u65B0\u5E94\u7528\u4E00\u6B21\uFF08\u6210\u5458\u81EA\u5DF1 Web UI \u6062\u590D\u7684\u4F1A\u8BDD\u4E5F\u8986\u76D6\uFF09\uFF1A",
      "\u6210\u5458\u9700\u8981\u4FE1\u606F\u65F6\u4F1A\u5728\u56DE\u590D\u91CC\u63D0\u95EE\u5E76\u505C\u4E0B\uFF0C\u7528 call_member \u5E26 conversationId \u56DE\u7B54\u3002",
      "`identity` / `role` / `scope` \u53EF\u9009\uFF1A\u8FD9\u4E2A\u4F1A\u8BDD\u7684\u8EAB\u4EFD\u3001\u6807\u51C6\u8EAB\u4EFD\uFF08\u4EA7\u54C1\u7ECF\u7406 / \u7814\u7A76\u5458 / \u5F00\u53D1 / \u6D4B\u8BD5 / \u4E1A\u52A1\uFF09\u548C\u8D1F\u8D23\u7684\u5DE5\u4F5C\u8303\u56F4\uFF0C\u6309\u4F1A\u8BDDid \u6301\u4E45\u5316\u5230 member-scopes.json\uFF1B",
      "\u65B0\u5EFA\u5BF9\u8BDD\u65F6\u628A\u672C\u6B21\u8EAB\u4EFD/\u8303\u56F4\u4F5C\u4E3A\u3010\u6210\u5458\u8EAB\u4EFD\u3011\u524D\u7F00\u653E\u8FDB prompt\uFF0C\u7EE7\u7EED\u5DF2\u6709\u5BF9\u8BDD\u65F6\u5408\u5E76\u8BE5\u4F1A\u8BDD\u7684\u8BBE\u7F6E\u5E76\u5728\u6D88\u606F\u524D\u52A0\u4E00\u884C\u3010\u6210\u5458\u8EAB\u4EFD\u3011\u8BF4\u660E\u3002",
      "\u4E5F\u53EF\u4EE5\u5728\u4EFB\u4F55\u65F6\u5019\u7528 set_member_scope \u5355\u72EC\u8BBE\u7F6E\u4EFB\u610F\u4F1A\u8BDD\u6216\u81EA\u8EAB\u7684\u8EAB\u4EFD/\u5DE5\u4F5C\u8303\u56F4\u3002",
      "\u8FD4\u56DE\u503C\u5E26 data.logFile\uFF0C\u6307\u5411\u8BE5\u4EFB\u52A1\u7684\u65E5\u5FD7\u6587\u4EF6\uFF1B\u4F1A\u8BDDid\u5728 text \u548C data.conversationId \u4E2D\u3002",
      "",
      "\u6210\u5458\u901A\u8FC7 WireGuard \u6210\u5458\u53D1\u73B0\u89E3\u6790\uFF08id/name/IP \u5747\u53EF\uFF09\uFF1B\u76EE\u6807 B \u7684 8765 interop \u670D\u52A1\u5FC5\u987B\u53EF\u8FBE\uFF0Ctoken \u9ED8\u8BA4\u590D\u7528\u7F51\u5173\u5BC6\u7801\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "\u53D1\u7ED9\u6210\u5458\u7684\u6D88\u606F\uFF1A\u65B0\u5EFA\u5BF9\u8BDD\u65F6\u662F\u521D\u59CB\u4EFB\u52A1\uFF0C\u7EE7\u7EED\u6295\u9012\u65F6\u662F\u8FD9\u4E00\u8F6E\u7684\u5185\u5BB9\u3002" },
        member: { type: "string", description: "\u6210\u5458 id\u3001\u540D\u79F0\u3001VPN IP \u6216 http(s) URL\u3002\u65B0\u5EFA\u5BF9\u8BDD\u65F6\u5FC5\u586B\uFF1B\u7EE7\u7EED\u6295\u9012\u4E14\u672C\u673A\u5DF2\u8DDF\u8E2A\u8BE5\u5BF9\u8BDD\u65F6\u53EF\u7701\u7565\u3002" },
        conversationId: { type: "string", description: "\u8981\u7EE7\u7EED\u7684\u4F1A\u8BDDid\uFF08call_member / wait_member \u8FD4\u56DE\uFF09\u3002\u7701\u7565\u5C31\u65B0\u5EFA\u5BF9\u8BDD\u3002" },
        cwd: { type: "string", description: "\u65B0\u5EFA\u5BF9\u8BDD\uFF1A\u6210\u5458 B \u4E0A\u7684\u5DE5\u4F5C\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u53EF\u7A7A\uFF09\u3002" },
        workspace: { type: "string", description: "\u65B0\u5EFA\u5BF9\u8BDD\uFF1A\u6210\u5458 B \u4E0A\u7684\u4EFB\u52A1\u5DE5\u4F5C\u533A\u540D\u79F0\uFF1B\u5B9E\u9645\u76EE\u5F55\u56FA\u5B9A\u4E3A\u6210\u5458\u672C\u673A\u7684 ~/.dsh/workspaces/<name>\u3002\u548C cwd \u4E8C\u9009\u4E00\u3002" },
        identity: { type: "string", description: "\u8FD9\u4E2A\u4F1A\u8BDD\u7684\u8EAB\u4EFD/\u89D2\u8272\uFF08\u4F8B\u5982 \u5185\u6838\u5F00\u53D1\u3001\u524D\u7AEF\u5F00\u53D1\u3001\u7F51\u5173\uFF09\uFF0C\u6700\u957F 40 \u5B57\u7B26\uFF1B\u4E0E\u5DF2\u6709\u8BBE\u7F6E\u5408\u5E76\uFF0C\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u6E05\u9664\u3002" },
        role: { type: "string", enum: [...MEMBER_ROLES, ""], description: `\u6807\u51C6\u8EAB\u4EFD\uFF0C\u53EA\u5BF9\u6210\u5458\u4F1A\u8BDD\u751F\u6548\uFF0C\u9636\u6BB5\u53C2\u4E0E\u6821\u9A8C\u6309\u5B83\u5224\u65AD\uFF1B\u53EF\u9009\uFF1A${MEMBER_ROLES.join(" / ")}\u3002\u4E0E\u5DF2\u6709\u8BBE\u7F6E\u5408\u5E76\uFF0C\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u6E05\u9664\u3002` },
        scope: { type: "string", description: "\u8FD9\u4E2A\u4F1A\u8BDD\u8D1F\u8D23\u7684\u5DE5\u4F5C\u8303\u56F4\uFF08\u4F8B\u5982 dsh-mesh \u63D2\u4EF6\u5F00\u53D1\u4E0E\u6784\u5EFA\u3001\u8DE8\u5E73\u53F0\u9A8C\u6536\uFF09\uFF0C\u6700\u957F 120 \u5B57\u7B26\uFF1B\u4E0E\u5DF2\u6709\u8BBE\u7F6E\u5408\u5E76\uFF0C\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u6E05\u9664\u3002" }
      },
      required: ["prompt"],
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
      if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw new Error("prompt is required");
      const conversationId = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
      const originSessionId = originSessionOf(exec.agent);
      if (conversationId === "") {
        if (typeof args.member !== "string" || args.member.trim() === "") {
          throw new Error("member is required to start a new conversation");
        }
        let task2;
        try {
          task2 = await memberTasks.start({
            member: args.member,
            prompt: args.prompt,
            cwd: args.cwd,
            workspace: args.workspace,
            identity: args.identity,
            role: args.role,
            scope: args.scope,
            agent: exec.agent,
            notify: true,
            signal: exec.signal
          });
        } catch (error) {
          if (error?.code === "workspace_occupied" || error?.code === "workspace_busy_git") {
            return workspaceBusyResult(error, args);
          }
          if (error?.code === "member_maintenance") return maintenanceResult(error, args);
          throw error;
        }
        const data2 = memberTaskData(task2, memberTasks);
        const conversationBlock2 = await originConversationBlock(memberTasks, originSessionId, task2.conversationId);
        return {
          ok: task2.status !== "failed",
          text: [
            `\u5DF2\u53D1\u8D77\u6210\u5458\u4EFB\u52A1\uFF1A${task2.member}\uFF08${task2.memberIp}\uFF09\uFF0C\u4F1A\u8BDD ${task2.conversationId}\u3002`,
            formatTaskProfileLine(task2),
            formatTaskProfileMissingHint(task2),
            typeof task2.egressLine === "string" && task2.egressLine !== "" ? `\u51FA\u7F51\u5B9E\u6D4B\uFF1A${task2.egressLine}` : "",
            `\u4F1A\u8BDDid\uFF1A${task2.conversationId}`,
            typeof task2.messageSpill === "string" && task2.messageSpill !== "" ? `\u6D88\u606F\u8FC7\u957F\uFF0C\u6B63\u6587\u5DF2\u5199\u5165\u6210\u5458\u672C\u673A\u6587\u4EF6\uFF1A${task2.messageSpill}\uFF08\u6295\u9012\u7684\u662F\u8BFB\u53D6\u8BE5\u6587\u4EF6\u7684\u8BF4\u660E\uFF09\u3002` : "",
            "\u7ED3\u679C\u4F1A\u81EA\u52A8\u6295\u9012\u5230\u672C\u5BF9\u8BDD\uFF1B\u4E0D\u53D6\u8D70\u4E5F\u4E0D\u4F1A\u4E22\uFF0C\u5DF2\u7ECF\u53D6\u8D70\u7684\u4E0D\u91CD\u590D\u3002",
            `\u8981\u7EE7\u7EED\u8FD9\u4E2A\u5BF9\u8BDD\uFF1Acall_member { "member": ${JSON.stringify(String(task2.member))}, "conversationId": ${JSON.stringify(String(task2.conversationId))}, "prompt": "..." }\u3002`,
            ...conversationBlock2.lines,
            task2.status === "failed" ? `\u5F53\u524D\u72B6\u6001\uFF1Afailed\uFF0C${task2.error ?? ""}` : "",
            `\u65E5\u5FD7\uFF1A${data2.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data: {
            ...data2,
            currentConversationId: task2.conversationId,
            conversations: conversationBlock2.conversations
          }
        };
      }
      const hasCwd = typeof args.cwd === "string" && args.cwd.trim() !== "";
      const hasWorkspace = typeof args.workspace === "string" && args.workspace.trim() !== "";
      if (hasCwd || hasWorkspace) throw new Error("cwd/workspace only apply to a new conversation");
      if (args.force === true) throw new Error("force only applies when starting a new conversation");
      let task;
      try {
        task = await memberTasks.send({
          conversationId,
          member: args.member,
          prompt: args.prompt,
          identity: args.identity,
          role: args.role,
          scope: args.scope,
          agent: exec.agent,
          signal: exec.signal
        });
      } catch (error) {
        if (error?.code === "member_maintenance") return maintenanceResult(error, args);
        throw error;
      }
      const data = memberTaskData(task, memberTasks);
      const compaction = task.lastCompaction;
      const observedPercent = Number.isFinite(compaction?.observedPercent) ? formatOneDecimal(compaction.observedPercent) : Number.isFinite(compaction?.forcedPercent) ? formatOneDecimal(compaction.forcedPercent) : "?";
      const forcedLine = compaction?.forced === true ? compaction.compacted === true ? `\u4E0A\u4E0B\u6587\u5360\u6BD4 ${observedPercent}% \u5DF2\u8D85\u8FC7\u538B\u7F29\u9608\u503C ${formatOneDecimal(compaction.forcedPercent)}%\uFF0C\u6295\u9012\u524D\u5DF2\u81EA\u52A8\u538B\u7F29\uFF1A\u66FF\u6362 ${String(compaction.shadowedCount)} \u9879\u5386\u53F2\uFF08\u7EA6 ${formatTokens(compaction.shadowedTokenCount ?? 0)} tokens\uFF09\u3002` : `\u4E0A\u4E0B\u6587\u5360\u6BD4 ${observedPercent}% \u5DF2\u8D85\u8FC7\u538B\u7F29\u9608\u503C ${formatOneDecimal(compaction.forcedPercent)}%\uFF0C\u6295\u9012\u524D\u5DF2\u5C1D\u8BD5\u81EA\u52A8\u538B\u7F29\uFF0C\u4F46\u6CA1\u6709\u53EF\u538B\u7F29\u7684\u5386\u53F2\u3002` : "";
      const conversationBlock = await originConversationBlock(memberTasks, originSessionId, task.conversationId);
      const deliveryLine = task.lastDelivery === "steer" ? "\u672C\u6B21\u6295\u9012\uFF1A\u76EE\u6807\u5BF9\u8BDD\u6B63\u5728\u8FD0\u884C\uFF0C\u6D88\u606F\u5DF2\u7528 steer \u63D2\u5165\u5F53\u524D turn\u3002" : task.lastDelivery === "followup" ? "\u672C\u6B21\u6295\u9012\uFF1A\u76EE\u6807\u5BF9\u8BDD\u7A7A\u95F2\uFF0C\u6D88\u606F\u5DF2\u6309 followup \u6392\u5165\u4E0B\u4E00\u8F6E\u3002" : "";
      return {
        ok: true,
        text: [
          `\u5DF2\u53D1\u9001\u5230 ${task.member}\uFF08${task.memberIp}\uFF09\u7684\u5BF9\u8BDD ${task.conversationId}\u3002`,
          formatTaskProfileLine(task),
          formatTaskProfileMissingHint(task),
          `\u4F1A\u8BDDid\uFF1A${task.conversationId}`,
          deliveryLine,
          forcedLine,
          typeof task.messageSpill === "string" && task.messageSpill !== "" ? `\u6D88\u606F\u8FC7\u957F\uFF0C\u6B63\u6587\u5DF2\u5199\u5165\u6210\u5458\u672C\u673A\u6587\u4EF6\uFF1A${task.messageSpill}\uFF08\u6295\u9012\u7684\u662F\u8BFB\u53D6\u8BE5\u6587\u4EF6\u7684\u8BF4\u660E\uFF09\u3002` : "",
          formatContextLine(task.context),
          "\u7ED3\u679C\u4F1A\u81EA\u52A8\u6295\u9012\u5230\u672C\u5BF9\u8BDD\uFF1B\u4E0D\u53D6\u8D70\u4E5F\u4E0D\u4F1A\u4E22\uFF0C\u5DF2\u7ECF\u53D6\u8D70\u7684\u4E0D\u91CD\u590D\u3002",
          ...conversationBlock.lines,
          `\u65E5\u5FD7\uFF1A${data.logFile}`
        ].filter((line) => line !== "").join("\n"),
        data: {
          ...data,
          currentConversationId: task.conversationId,
          conversations: conversationBlock.conversations
        }
      };
    }
  };
  const setMemberScopeDefinition = {
    name: "set_member_scope",
    description: [
      "\u8BBE\u7F6E\u4E00\u4E2A\u6210\u5458\u4F1A\u8BDD\u6216\u5F53\u524D\u4E3B\u5BF9\u8BDD\uFF08\u81EA\u8EAB\uFF09\u7684\u8EAB\u4EFD\u3001\u6807\u51C6\u8EAB\u4EFD\u3001\u5DE5\u4F5C\u8303\u56F4\uFF0C\u4EE5\u53CA\u81EA\u7EE7\u7EED\u3001wait_member\u3001turn-end \u538B\u7F29\u7B49\u5F00\u5173\u3002",
      "",
      "`conversationId` \u7701\u7565\u3001`self`\u3001`local` \u6216\u7B49\u4E8E\u5F53\u524D\u4F1A\u8BDD id \u65F6\u8BBE\u7F6E\u201C\u81EA\u8EAB\u201D\uFF1B\u5176\u4ED6\u503C\u4F5C\u4E3A\u6210\u5458\u4F1A\u8BDD id\u3002",
      "`identity` / `role` / `scope` / `note` \u662F\u53EF\u9009\u7684\u5B57\u7B26\u4E32\uFF0C\u53EA\u4F20\u8981\u6539\u7684\u5B57\u6BB5\uFF1B\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u6E05\u9664\u3002",
      "identity \u6700\u957F 40 \u5B57\u7B26\uFF0Cscope \u6700\u957F 120 \u5B57\u7B26\uFF0Cnote\uFF08\u5907\u6CE8\uFF09\u6700\u957F 500 \u5B57\u7B26\u3002",
      "`role` \u662F\u6210\u5458\u7684\u6807\u51C6\u8EAB\u4EFD\uFF0C\u53EA\u5BF9\u6210\u5458\u4F1A\u8BDD\u751F\u6548\uFF1A\u4EA7\u54C1\u7ECF\u7406 / \u7814\u7A76\u5458 / \u5F00\u53D1 / \u6D4B\u8BD5 / \u4E1A\u52A1\uFF1Bset_product_stage \u7684\u9636\u6BB5\u53C2\u4E0E\u6821\u9A8C\u6309\u5B83\u5224\u65AD\u3002\u8BBE\u7F6E\u81EA\u8EAB\u65F6\u5FFD\u7565\u3002",
      "`note` \u4EC5\u5BF9\u6210\u5458\u4F1A\u8BDD\u751F\u6548\uFF1A\u5B83\u4E0D\u4F1A\u6CE8\u5165\u6210\u5458\u7684\u7CFB\u7EDF\u4E0A\u4E0B\u6587\uFF0C\u4E5F\u4E0D\u4F1A\u968F call_member \u6295\u9012\uFF0C\u53EA\u5728\u4E3B\u5BF9\u8BDD\u7684 status_member \u548C\u6210\u5458\u4E0A\u4E0B\u6587\u91CC\u53EF\u89C1\uFF1B\u8BBE\u7F6E\u81EA\u8EAB\u65F6\u5FFD\u7565\u3002",
      "`keep` \u9ED8\u8BA4 false\uFF0C\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF1A\u5F00\u542F\u540E\uFF0C\u6BCF\u4E2A turn \u7ED3\u675F\u4E14\u672C\u5BF9\u8BDD\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6210\u5458\u4F1A\u8BDD\u65F6\uFF0C\u63D2\u4EF6\u5411\u672C\u5BF9\u8BDD\u6295\u9012\u4E00\u6761\u7528\u6237\u6D88\u606F\u300C\u7EE7\u7EED\u300D\uFF1B\u7531\u8FD9\u6761\u6D88\u606F\u62C9\u8D77\u7684\u8FD9\u4E00\u8F6E\u7ED3\u675F\u65F6\u4E0D\u4F1A\u518D\u6B21\u6295\u9012\uFF0C\u907F\u514D\u81EA\u5FAA\u73AF\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002",
      "`keepPrompt`\uFF08\u4E5F\u53EF\u5199 `keep_prompt`\uFF09\u662F\u8FD9\u6761\u7528\u6237\u6D88\u606F\u7684\u6B63\u6587\uFF0C\u9ED8\u8BA4\u300C\u7EE7\u7EED\u300D\uFF0C\u6700\u957F 200 \u5B57\u7B26\uFF1B\u7A7A\u5B57\u7B26\u4E32\u6062\u590D\u9ED8\u8BA4\u3002\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002",
      "`avoidLongJobs` \u9ED8\u8BA4 false\uFF0C\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF1A\u5F00\u542F\u540E\uFF0C\u4E3B\u5BF9\u8BDD\u4E0B\u4E00\u6B21\u72B6\u6001\u5FEB\u7167\u4F1A\u5217\u51FA\u8DDD\u4E0A\u4E00\u6B21\u5FEB\u7167\u4E4B\u95F4\u7ED3\u675F\u3001\u8017\u65F6\u8D85\u8FC7 1 \u5206\u949F\u7684 job\uFF0C\u5E76\u5EFA\u8BAE\u4EA4\u7ED9\u6210\u5458\u5BF9\u8BDD\u6267\u884C\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002",
      "`budgetAudit` \u9ED8\u8BA4 false\uFF0C\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF1A\u5F00\u542F\u540E\uFF0Ccall_member \u9884\u7B97\u8017\u5C3D\u65F6\u542F\u52A8 fork \u5B50\u4EE3\u7406\u5BA1\u67E5\u4EA7\u54C1\u6D41\u7A0B\uFF08\u6BCF\u4E2A\u5C0F\u9636\u6BB5\u6700\u591A 3 \u6B21\u3001\u95F4\u9694\u81F3\u5C11 10 \u5206\u949F\uFF09\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002",
      "`waitMember` \u9ED8\u8BA4 true\uFF0C\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF1A\u8BBE\u4E3A false \u540E wait_member \u76F4\u63A5\u8FD4\u56DE ok:false\uFF0C\u4E0D\u518D\u963B\u585E\u7B49\u5F85\uFF1B\u6210\u5458\u56DE\u590D\u4ECD\u4F1A\u81EA\u52A8\u6295\u9012\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002",
      "`compressOnTurnEnd` \u9ED8\u8BA4 false\uFF0C\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF1A\u5F00\u542F\u540E\u6BCF\u4E2A turn/end \u8BFB\u53D6\u672C\u5BF9\u8BDD\u4E0A\u4E0B\u6587\u5360\u6BD4\uFF0C\u8D85\u8FC7 compressPercent \u5C31\u7528 DSH \u7684\u663E\u5F0F\u538B\u7F29\uFF08compactNow\uFF09\u538B\u7F29\u4E00\u6B21\uFF1B\u53EA\u538B\u7F29\u4E3B\u5BF9\u8BDD\uFF0C\u6210\u5458\u4F1A\u8BDD\u4E0D\u53D7\u5F71\u54CD\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002",
      "`callMemberBudget`\uFF08\u4E5F\u53EF\u5199 `call_member_budget`\uFF09\u662F**\u6BCF\u4E2A\u5927\u9636\u6BB5\u5355\u72EC**\u7684 call_member \u9884\u7B97\uFF0C\u53EF\u53EA\u7ED9\u8981\u8BBE\u7684\u9636\u6BB5\uFF08A/B/C/D\uFF09\uFF0C\u6BCF\u4E2A\u6574\u6570 1\u2013999\uFF0C\u6CA1\u6709\u7EDF\u4E00\u503C\uFF1B\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\u3002\u6CA1\u8BBE\u7F6E\u7684\u9636\u6BB5\u5728\u8FD0\u884C\u65F6\u9ED8\u8BA4\u4E3A\u8BE5\u9636\u6BB5**\u53C2\u4E0E\u6210\u5458\u6570\u91CF \xD7 2**\uFF08\u8FD8\u6CA1\u6709\u53C2\u4E0E\u6210\u5458\u65F6\u6309 1 \u8BA1\uFF09\u3002\u6210\u5458\u6BCF\u628A\u4E00\u6761\u56DE\u590D\u8FD4\u56DE\u7ED9\u4E3B\u5BF9\u8BDD\uFF08wait_member \u53D6\u8D70\u6216\u515C\u5E95\u6295\u9012\uFF09\u7B97\u5BF9\u5E94\u9636\u6BB5\u6D88\u8017\u4E00\u6B21\uFF1B\u9884\u7B97\u7528\u5B8C\u65F6\u6210\u5458\u4E0A\u4E0B\u6587\u4F1A\u5F3A\u8C03\u5FC5\u987B\u8FDB\u5165\u4E0B\u4E00\u4E2A\u9636\u6BB5\uFF0C\u5E76\u53CA\u65F6\u7528 set_product_stage \u66F4\u65B0\u9636\u6BB5\u548C\u76EE\u6807\u72B6\u6001\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002",
      `\u9884\u7B97\u989D\u5EA6\u53EA\u80FD\u7531\u7528\u6237\u8C03\u6574\uFF1A\u8BBE\u7F6E callMemberBudget \u65F6\u5DE5\u5177\u4F1A\u8BFB\u53D6\u6700\u8FD1 ${String(BUDGET_AUTH_MESSAGE_WINDOW)} \u6761\u7528\u6237\u6D88\u606F\uFF0C\u53EA\u6709\u5176\u4E2D\u5B58\u5728\u201C\u9884\u7B97 + \u8C03\u6574/\u8BBE\u7F6E + \u6570\u5B57\u201D\u7684\u660E\u786E\u6307\u793A\u624D\u5199\u5165\uFF1B\u6CA1\u6709\u5219\u8FD4\u56DE ok:false\uFF0C\u914D\u7F6E\u4E0D\u53D8\u3002`,
      "\u9884\u7B97\u7528\u5C3D\u65F6\uFF0C\u6210\u5458\u4E0A\u4E0B\u6587\u4F1A\u81EA\u52A8\u542F\u52A8\u4E00\u4E2A fork \u5B50\u4EE3\u7406\u5BA1\u67E5\u5F53\u524D\u4EA7\u54C1\u6D41\u7A0B\uFF08\u6BCF\u4E2A\u5C0F\u9636\u6BB5\u6700\u591A 3 \u6B21\u3001\u95F4\u9694\u81F3\u5C11 10 \u5206\u949F\uFF09\uFF1A\u68C0\u67E5\u662F\u5426\u6309\u9636\u6BB5\u5DE5\u4F5C\u3001\u662F\u5426\u8D85\u51FA\u9636\u6BB5\u3001\u9884\u7B97\u4E3A\u4EC0\u4E48\u8017\u5C3D\uFF1B\u5982\u679C\u4E3B\u5BF9\u8BDD\u4F7F\u7528\u4E0D\u5408\u7406\uFF0C\u5BA1\u67E5\u7ED3\u8BBA\u4F1A\u4F5C\u4E3A\u8B66\u544A\u548C\u4E0B\u4E00\u6B65\u5EFA\u8BAE\u6295\u9012\u56DE\u4E3B\u5BF9\u8BDD\u3002",
      `\`compressPercent\`\uFF1A\u81EA\u52A8\u538B\u7F29\u9608\u503C\uFF08\u6570\u5B57 1\u2013100\uFF0C\u9ED8\u8BA4 ${String(DEFAULT_COMPRESS_PERCENT)}\uFF09\uFF1B\u6210\u5458\u4F1A\u8BDD\u4E0B\u4E00\u6B21 call_member \u6295\u9012\u524D\u8D85\u8FC7\u9608\u503C\u5C31\u5148\u538B\u7F29\uFF1B\u4E3B\u5BF9\u8BDD\u5F00\u542F compressOnTurnEnd \u540E\u4F5C\u4E3A turn/end \u7684\u538B\u7F29\u9608\u503C\u3002`,
      "\u81F3\u5C11\u63D0\u4F9B identity\u3001role\u3001scope\u3001note\u3001keep\u3001keepPrompt\u3001avoidLongJobs\u3001budgetAudit\u3001waitMember\u3001compressOnTurnEnd\u3001callMemberBudget\u3001compressPercent \u4E4B\u4E00\uFF1B\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FC5\u987B\u6709 identity\u3001role\u3001scope\u3001note \u6216 compressPercent \u4E4B\u4E00\u3002",
      "\u6210\u5458\u4F1A\u8BDD\u53EF\u4EE5\u672A\u88AB\u672C\u673A\u8DDF\u8E2A\uFF0C\u8BBE\u7F6E\u4ECD\u4F1A\u4FDD\u5B58\uFF0C\u53EA\u662F\u4E0D\u4F1A\u540C\u6B65\u4EFB\u52A1\u5FEB\u7167\u3002",
      "\u8FD9\u4E2A\u5DE5\u5177\u53EA\u4FDD\u5B58\u8BBE\u7F6E\uFF0C\u4E0D\u7ED9\u6210\u5458\u4F1A\u8BDD\u53D1\u6D88\u606F\u3001\u4E0D\u81EA\u52A8\u52A0\u6295\u9012\u524D\u7F00\uFF1B\u968F\u5BF9\u8BDD\u4E00\u8D77\u8BBE\u7F6E/\u66F4\u65B0\u7528 call_member \u7684 identity/role/scope \u53C2\u6570\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "\u8981\u8BBE\u7F6E\u7684\u4F1A\u8BDDid\uFF1B\u7701\u7565\u3001self\u3001local \u6216\u5F53\u524D\u4F1A\u8BDDid \u8868\u793A\u81EA\u8EAB\u3002"
        },
        identity: {
          type: "string",
          description: "\u8EAB\u4EFD/\u89D2\u8272\uFF08\u4F8B\u5982 \u5185\u6838\u5F00\u53D1\u3001\u524D\u7AEF\u5F00\u53D1\u3001\u7F51\u5173\uFF09\uFF0C\u6700\u957F 40 \u5B57\u7B26\uFF1B\u7A7A\u5B57\u7B26\u4E32\u6E05\u9664\u3002"
        },
        role: {
          type: "string",
          enum: [...MEMBER_ROLES, ""],
          description: `\u6807\u51C6\u8EAB\u4EFD\uFF0C\u53EA\u5BF9\u6210\u5458\u4F1A\u8BDD\u751F\u6548\uFF0C\u9636\u6BB5\u53C2\u4E0E\u6821\u9A8C\u6309\u5B83\u5224\u65AD\uFF1A${MEMBER_ROLES.join(" / ")}\uFF1B\u7A7A\u5B57\u7B26\u4E32\u6E05\u9664\u3002\u8BBE\u7F6E\u81EA\u8EAB\u65F6\u5FFD\u7565\u3002`
        },
        scope: {
          type: "string",
          description: "\u8D1F\u8D23/\u5DE5\u4F5C\u8303\u56F4\uFF08\u4F8B\u5982 dsh-mesh \u63D2\u4EF6\u5F00\u53D1\u4E0E\u6784\u5EFA\u3001\u8DE8\u5E73\u53F0\u9A8C\u6536\uFF09\uFF0C\u6700\u957F 120 \u5B57\u7B26\uFF1B\u7A7A\u5B57\u7B26\u4E32\u6E05\u9664\u3002"
        },
        note: {
          type: "string",
          description: "\u5907\u6CE8\uFF0C\u4EC5\u5BF9\u6210\u5458\u4F1A\u8BDD\u751F\u6548\uFF0C\u6700\u957F 500 \u5B57\u7B26\uFF1B\u53EA\u5B58\u672C\u673A\u3001\u53EA\u5728\u4E3B\u5BF9\u8BDD\u53EF\u89C1\uFF0C\u4E0D\u4F1A\u6CE8\u5165\u6216\u6295\u9012\u7ED9\u6210\u5458\uFF1B\u7A7A\u5B57\u7B26\u4E32\u6E05\u9664\u3002\u8BBE\u7F6E\u81EA\u8EAB\u65F6\u5FFD\u7565\u3002"
        },
        keep: {
          type: "boolean",
          description: "\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u9ED8\u8BA4 false\uFF1B\u5F00\u542F\u540E\u6BCF\u4E2A turn \u7ED3\u675F\u4E14\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6210\u5458\u4F1A\u8BDD\u65F6\u6295\u9012\u4E00\u6761\u7528\u6237\u6D88\u606F\u300C\u7EE7\u7EED\u300D\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002"
        },
        keepPrompt: {
          type: "string",
          maxLength: 200,
          description: "\u81EA\u7EE7\u7EED\u63D0\u793A\u8BED\uFF0C\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u9ED8\u8BA4\u300C\u7EE7\u7EED\u300D\uFF1B\u7A7A\u5B57\u7B26\u4E32\u6062\u590D\u9ED8\u8BA4\u3002\u4E5F\u53EF\u4EE5\u5199\u6210 keep_prompt\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002"
        },
        keep_prompt: {
          type: "string",
          maxLength: 200,
          description: "keepPrompt \u7684\u522B\u540D\uFF1B\u4E0E keepPrompt \u53EA\u4F20\u4E00\u4E2A\u3002"
        },
        avoidLongJobs: {
          type: "boolean",
          description: "\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u9ED8\u8BA4 false\uFF1B\u5F00\u542F\u540E\u72B6\u6001\u5FEB\u7167\u4F1A\u5217\u51FA\u4E24\u6B21\u5FEB\u7167\u95F4\u7ED3\u675F\u3001\u8017\u65F6\u8D85\u8FC7 1 \u5206\u949F\u7684 job\uFF0C\u5E76\u5EFA\u8BAE\u4EA4\u7ED9\u6210\u5458\u5BF9\u8BDD\u6267\u884C\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002"
        },
        budgetAudit: {
          type: "boolean",
          description: "\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u9ED8\u8BA4 false\uFF1B\u5F00\u542F\u540E call_member \u9884\u7B97\u8017\u5C3D\u65F6\u81EA\u52A8\u8D77 fork \u5B50\u4EE3\u7406\u5BA1\u67E5\u4EA7\u54C1\u6D41\u7A0B\uFF08\u6BCF\u9636\u6BB5\u6700\u591A 3 \u6B21\u3001\u95F4\u9694 10 \u5206\u949F\uFF09\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002"
        },
        waitMember: {
          type: "boolean",
          description: "\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u9ED8\u8BA4 true\uFF1B\u8BBE\u4E3A false \u540E wait_member \u76F4\u63A5\u8FD4\u56DE ok:false\uFF0C\u4E0D\u518D\u963B\u585E\u7B49\u5F85\uFF0C\u6210\u5458\u56DE\u590D\u4ECD\u4F1A\u81EA\u52A8\u6295\u9012\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002"
        },
        compressOnTurnEnd: {
          type: "boolean",
          description: "\u53EA\u5BF9\u81EA\u8EAB/\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u9ED8\u8BA4 false\uFF1B\u5F00\u542F\u540E\u6BCF\u4E2A turn/end \u68C0\u67E5\u672C\u5BF9\u8BDD\u4E0A\u4E0B\u6587\u5360\u6BD4\uFF0C\u8D85\u8FC7 compressPercent \u5C31\u538B\u7F29\u4E00\u6B21\uFF08DSH compactNow\uFF0C\u53EA\u538B\u4E3B\u5BF9\u8BDD\uFF09\u3002\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5FFD\u7565\u3002"
        },
        callMemberBudget: callMemberBudgetSchema(),
        call_member_budget: {
          ...callMemberBudgetSchema(),
          description: "callMemberBudget \u7684\u522B\u540D\uFF1B\u4E0E callMemberBudget \u53EA\u4F20\u4E00\u4E2A\u3002"
        },
        compressPercent: {
          type: "number",
          minimum: 1,
          maximum: 100,
          description: "\u81EA\u52A8\u538B\u7F29\u9608\u503C\uFF08\u767E\u5206\u6BD4\uFF0C\u9ED8\u8BA4 35\uFF09\uFF1B\u6210\u5458\u4F1A\u8BDD\u4E0B\u6B21\u6295\u9012\u524D\u8D85\u8FC7\u8BE5\u503C\u5C31\u5148\u538B\u7F29\uFF1B\u4E3B\u5BF9\u8BDD\u5F00\u542F compressOnTurnEnd \u540E\u4F5C\u4E3A turn/end \u7684\u538B\u7F29\u9608\u503C\u3002"
        }
      },
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
      const selfId = originSessionOf(exec?.agent);
      const rawId = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
      const isSelf = rawId === "" || rawId === "self" || rawId === "local" || selfId !== "" && rawId === selfId;
      const hasIdentity = args.identity !== void 0;
      const hasRole = args.role !== void 0;
      const hasScope = args.scope !== void 0;
      const hasNote = args.note !== void 0;
      const hasKeep = args.keep !== void 0;
      const hasKeepPrompt = args.keepPrompt !== void 0 || args.keep_prompt !== void 0;
      const hasAvoidLongJobs = args.avoidLongJobs !== void 0;
      const hasBudgetAudit = args.budgetAudit !== void 0;
      const hasWaitMember = args.waitMember !== void 0;
      const hasCompressOnTurnEnd = args.compressOnTurnEnd !== void 0;
      const hasCallMemberBudget = args.callMemberBudget !== void 0 || args.call_member_budget !== void 0;
      const hasCompressPercent = args.compressPercent !== void 0;
      if (!hasIdentity && !hasRole && !hasScope && !hasNote && !hasKeep && !hasKeepPrompt && !hasAvoidLongJobs && !hasBudgetAudit && !hasWaitMember && !hasCompressOnTurnEnd && !hasCallMemberBudget && !hasCompressPercent) {
        throw new Error("identity, role, scope, note, keep, keepPrompt, avoidLongJobs, budgetAudit, waitMember, compressOnTurnEnd, callMemberBudget, or compressPercent is required");
      }
      if (args.keepPrompt !== void 0 && args.keep_prompt !== void 0) {
        throw new Error("use only one of keepPrompt and keep_prompt");
      }
      if (args.callMemberBudget !== void 0 && args.call_member_budget !== void 0) {
        throw new Error("use only one of callMemberBudget and call_member_budget");
      }
      if (isSelf && selfId === "") throw new Error("cannot set the current session scope: no current session");
      if (!isSelf && !hasIdentity && !hasRole && !hasScope && !hasNote && !hasCompressPercent) {
        throw new Error("keep, keepPrompt, avoidLongJobs, budgetAudit, waitMember, compressOnTurnEnd and callMemberBudget only apply to the current session; set identity, role, scope, note, or compressPercent for a member conversation");
      }
      const patch = {
        ...hasIdentity ? { identity: args.identity } : {},
        ...!isSelf && hasRole ? { role: args.role } : {},
        ...hasScope ? { scope: args.scope } : {},
        ...!isSelf && hasNote ? { note: args.note } : {},
        ...isSelf && hasKeep ? { keep: args.keep } : {},
        ...isSelf && hasKeepPrompt ? { keepPrompt: args.keepPrompt !== void 0 ? args.keepPrompt : args.keep_prompt } : {},
        ...isSelf && hasAvoidLongJobs ? { avoidLongJobs: args.avoidLongJobs } : {},
        ...isSelf && hasBudgetAudit ? { budgetAudit: args.budgetAudit } : {},
        ...isSelf && hasWaitMember ? { waitMember: args.waitMember } : {},
        ...isSelf && hasCompressOnTurnEnd ? { compressOnTurnEnd: args.compressOnTurnEnd } : {},
        ...isSelf && hasCallMemberBudget ? { callMemberBudget: args.callMemberBudget !== void 0 ? args.callMemberBudget : args.call_member_budget } : {},
        ...hasCompressPercent ? { compressPercent: args.compressPercent } : {}
      };
      normalizeMemberScopePatch(patch);
      if (isSelf && hasCallMemberBudget && !hasBudgetInstructionFromUser(exec?.agent)) {
        return {
          ok: false,
          text: [
            `\u9884\u7B97\u989D\u5EA6\u53EA\u80FD\u7531\u7528\u6237\u8C03\u6574\uFF1A\u6700\u8FD1 ${String(BUDGET_AUTH_MESSAGE_WINDOW)} \u6761\u7528\u6237\u6D88\u606F\u91CC\u6CA1\u6709\u8C03\u6574 call_member \u9884\u7B97\u7684\u6307\u793A\uFF0C\u672C\u6B21\u8BBE\u7F6E\u5DF2\u62D2\u7EDD\uFF0C\u914D\u7F6E\u6CA1\u6709\u6539\u53D8\u3002`,
            "\u8BF7\u8BA9\u7528\u6237\u660E\u786E\u8BF4\u660E\u8981\u8C03\u6574\u54EA\u4E2A\u5927\u9636\u6BB5\u3001\u8C03\u6574\u5230\u591A\u5C11\uFF08\u4F8B\u5982\u300C\u628A A \u9636\u6BB5\u9884\u7B97\u8C03\u5230 26\u300D\uFF09\uFF0C\u518D\u91CD\u8BD5\u3002"
          ].join("\n"),
          data: { refused: true, reason: "budget_requires_user_instruction" }
        };
      }
      const targetId = isSelf ? selfId : rawId;
      const saved = await service.setMemberScope(targetId, patch);
      const scope = saved.scope ?? null;
      const tracked = isSelf ? false : await memberTasks.syncTaskScope(targetId, scope, { profile: hasIdentity || hasRole || hasScope });
      const compressThreshold = effectiveCompressPercent(scope);
      const keepPrompt = typeof scope?.keepPrompt === "string" && scope.keepPrompt !== "" ? scope.keepPrompt : DEFAULT_KEEP_PROMPT;
      const budgetText = formatCallMemberBudgetSettings(scope?.callMemberBudget);
      const lines = [
        isSelf ? `\u5DF2\u8BBE\u7F6E\u81EA\u8EAB\uFF08\u4F1A\u8BDD ${selfId}\uFF09\u7684\u8EAB\u4EFD/\u5DE5\u4F5C\u8303\u56F4\u4E0E\u914D\u7F6E\u3002` : `\u5DF2\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD ${targetId} \u7684\u8EAB\u4EFD\u3001\u6807\u51C6\u8EAB\u4EFD\u4E0E\u538B\u7F29\u9608\u503C\u3002`,
        ...!isSelf ? [`\u6807\u51C6\u8EAB\u4EFD\uFF1A${scope?.role ?? "\u672A\u8BBE\u7F6E"}`] : [],
        `\u8EAB\u4EFD\uFF1A${scope?.identity ?? "\u672A\u8BBE\u7F6E"}`,
        `\u5DE5\u4F5C\u8303\u56F4\uFF1A${scope?.scope ?? "\u672A\u8BBE\u7F6E"}`,
        ...!isSelf ? [`\u5907\u6CE8\uFF1A${scope?.note ?? "\u672A\u8BBE\u7F6E"}`] : [],
        ...isSelf ? [
          `\u4FDD\u6301\u76EE\u6807\uFF1A${scope?.keep === true ? `\u5F00\u542F\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u63D0\u793A\u8BED\u300C${keepPrompt}\u300D\uFF09` : "\u5173\u95ED\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09"}`,
          `\u907F\u514D\u8017\u65F6\uFF1A${scope?.avoidLongJobs === true ? "\u5F00\u542F" : "\u5173\u95ED"}\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09`,
          `\u9884\u7B97\u5BA1\u67E5\uFF1A${scope?.budgetAudit === true ? "\u5F00\u542F\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09" : "\u5173\u95ED\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09"}`,
          `wait_member\uFF1A${scope?.waitMember === false ? "\u5173\u95ED\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09" : "\u5F00\u542F\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09"}`,
          `turn/end \u81EA\u52A8\u538B\u7F29\uFF1A${scope?.compressOnTurnEnd === true ? "\u5F00\u542F\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09" : "\u5173\u95ED\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF09"}`,
          `call_member \u9884\u7B97\uFF1A${budgetText}\uFF08\u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u751F\u6548\uFF0C\u6BCF\u4E2A\u5927\u9636\u6BB5\u5355\u72EC\u8BA1\uFF1B\u672A\u8BBE\u7F6E\u6309\u53C2\u4E0E\u6210\u5458\u6570 \xD7 2\uFF09`,
          `\u538B\u7F29\u9608\u503C\uFF1A${formatOneDecimal(compressThreshold)}%`
        ] : [`\u538B\u7F29\u9608\u503C\uFF1A${formatOneDecimal(compressThreshold)}%\uFF08\u6295\u9012\u524D\u8D85\u8FC7\u8BE5\u5360\u6BD4\u81EA\u52A8\u538B\u7F29\uFF09`],
        ...!isSelf && (hasKeep || hasKeepPrompt || hasAvoidLongJobs || hasBudgetAudit || hasWaitMember || hasCompressOnTurnEnd || hasCallMemberBudget) ? ["keep / keepPrompt / avoidLongJobs / budgetAudit / waitMember / compressOnTurnEnd / callMemberBudget \u53EA\u5BF9\u4E3B\u5BF9\u8BDD\u81EA\u8EAB\u751F\u6548\uFF0C\u8BBE\u7F6E\u6210\u5458\u4F1A\u8BDD\u65F6\u5DF2\u5FFD\u7565\u3002"] : [],
        ...isSelf && hasRole ? ["role \u53EA\u5BF9\u6210\u5458\u4F1A\u8BDD\u751F\u6548\uFF0C\u8BBE\u7F6E\u81EA\u8EAB\u65F6\u5DF2\u5FFD\u7565\u3002"] : [],
        ...isSelf && hasNote ? ["note \u53EA\u5BF9\u6210\u5458\u4F1A\u8BDD\u751F\u6548\uFF0C\u8BBE\u7F6E\u81EA\u8EAB\u65F6\u5DF2\u5FFD\u7565\u3002"] : [],
        ...!isSelf && !tracked ? ["\u672C\u673A\u672A\u8DDF\u8E2A\u8BE5\u4F1A\u8BDD\uFF0C\u53EA\u4FDD\u5B58\u8BBE\u7F6E\u3002"] : []
      ];
      return {
        ok: true,
        text: lines.join("\n"),
        data: {
          target: isSelf ? "self" : "conversation",
          conversationId: targetId,
          self: isSelf,
          scope,
          compressPercent: compressThreshold,
          role: !isSelf ? scope?.role ?? null : null,
          keep: isSelf ? scope?.keep === true : null,
          keepPrompt: isSelf ? keepPrompt : null,
          avoidLongJobs: scope?.avoidLongJobs === true,
          budgetAudit: isSelf ? scope?.budgetAudit === true : null,
          waitMember: isSelf ? scope?.waitMember !== false : null,
          compressOnTurnEnd: isSelf ? scope?.compressOnTurnEnd === true : null,
          callMemberBudget: isSelf ? scope?.callMemberBudget ?? null : null,
          tracked,
          note: !isSelf ? scope?.note ?? null : null,
          ignoredRole: isSelf && hasRole,
          ignoredKeep: !isSelf && hasKeep,
          ignoredKeepPrompt: !isSelf && hasKeepPrompt,
          ignoredAvoidLongJobs: !isSelf && hasAvoidLongJobs,
          ignoredBudgetAudit: !isSelf && hasBudgetAudit,
          ignoredWaitMember: !isSelf && hasWaitMember,
          ignoredCompressOnTurnEnd: !isSelf && hasCompressOnTurnEnd,
          ignoredCallMemberBudget: !isSelf && hasCallMemberBudget,
          ignoredNote: isSelf && hasNote
        }
      };
    }
  };
  function goalSchema(label) {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        category: {
          type: "string",
          maxLength: 20,
          description: `\u76EE\u6807\u7C7B\u522B\uFF08\u5982 ${PRODUCT_GOAL_CATEGORY_HINT}\uFF1B\u4E5F\u53EF\u7528\u5176\u4ED6\u77ED\u7C7B\u522B\u8BCD\uFF09\uFF1B\u7701\u7565\u65F6\u4ECE text \u5F00\u5934\u8BC6\u522B\u3002\u63D0\u4F9B category \u65F6 text \u53EA\u5199\u300C\u73B0\u72B6 \u2026\uFF0C\u9884\u671F \u2026\u300D\u3002`
        },
        text: {
          type: "string",
          maxLength: 300,
          description: `${label}\u6587\u672C\uFF0C\u56FA\u5B9A\u683C\u5F0F\u300C<\u7C7B\u522B> \u73B0\u72B6 <\u73B0\u5728\u600E\u6837>\uFF0C\u9884\u671F <\u8981\u53D8\u6210\u600E\u6837>\u3002\u300D\uFF1B\u63D0\u4F9B category \u65F6 text \u53EA\u5199\u300C\u73B0\u72B6 \u2026\uFF0C\u9884\u671F \u2026\u300D\uFF0C\u5426\u5219 text \u5F00\u5934\u5FC5\u987B\u5E26\u7C7B\u522B\u3002\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u6E05\u9664\u3002`
        },
        status: {
          type: "string",
          enum: ["\u672A\u5F00\u59CB", "\u8FDB\u884C\u4E2D", "\u5DF2\u8FBE\u6210", "\u672A\u8FBE\u6210", ""],
          description: `${label}\u72B6\u6001\uFF1B\u7A7A\u5B57\u7B26\u4E32\u8868\u793A\u56DE\u5230\u300C\u672A\u5F00\u59CB\u300D\u3002`
        }
      }
    };
  }
  const setProductStageDefinition = {
    name: "set_product_stage",
    description: [
      "\u8BBE\u7F6E\u5F53\u524D\u9879\u76EE\u7684\u4EA7\u54C1\u7248\u672C\u3001\u5927\u9636\u6BB5\u3001\u5B50\u9636\u6BB5\u8F6E\u6B21\u548C\u76EE\u6807\u72B6\u6001\u3002",
      "",
      "\u5927\u9636\u6BB5\uFF1AA \u8BA1\u5212\u4E0E\u76EE\u6807\uFF08\u6240\u6709\u6210\u5458\u53C2\u4E0E\u63D0\u51FA\u5EFA\u8BAE\uFF0C\u6700\u540E\u7531\u4E3B\u5BF9\u8BDD\u51B3\u5B9A\u672C\u8F6E\u8BA1\u5212\u4E0E\u76EE\u6807\uFF09\uFF1B",
      "B \u5F00\u53D1\u4E0E\u6D4B\u8BD5\uFF08\u5F00\u53D1/\u6D4B\u8BD5/\u7814\u7A76\u5458/\u4EA7\u54C1\u7ECF\u7406\u53C2\u4E0E\uFF1B\u672C\u8F6E\u5F00\u53D1\u7684\u529F\u80FD\u6CA1\u6709 BUG\uFF0C\u7591\u96BE\u6742\u75C7\u9664\u5916\uFF1B\u4EA7\u54C1\u7ECF\u7406\u8C03\u7814\u7ADE\u54C1\u3001\u4E0E\u81EA\u5BB6\u4EA7\u54C1\u5BF9\u6BD4\u5E76\u8F93\u51FA\u62A5\u544A\uFF0C\u4E3A\u4E0B\u4E00\u8F6E A \u9636\u6BB5\u505A\u51C6\u5907\uFF09\uFF1B",
      "C \u4EA7\u54C1\u7ECF\u7406\u4F7F\u7528\uFF08\u4EA7\u54C1\u7ECF\u7406\u771F\u5B9E\u4F7F\u7528\uFF0C\u53D1\u73B0\u95EE\u9898\u56DE\u5230 B \u9636\u6BB5\uFF0C\u76F4\u5230\u4EA7\u54C1\u7ECF\u7406\u653E\u884C\uFF09\uFF1B",
      "D \u4E1A\u52A1\u4ECB\u5165\uFF08\u4E1A\u52A1\u4EBA\u5458\u5F00\u5C55\u4E1A\u52A1\u5DE5\u4F5C\uFF0C\u53D1\u73B0\u95EE\u9898\u56DE\u5230 C \u9636\u6BB5\uFF0C\u4E1A\u52A1\u653E\u884C\u540E\u56DE\u5230 A \u9636\u6BB5\uFF09\u3002",
      "\u4EA7\u54C1\u7248\u672C\u81EA\u52A8\u7EF4\u62A4\uFF0C\u4E0D\u9700\u8981\u4F20\u5165\uFF0C\u683C\u5F0F\u4E3A Major.Minor.Revision\uFF08\u5982 20261128.1.1\uFF09\uFF1AD \u5B8C\u6210\u8FDB\u5165 A \u65F6\u5347\u7248\uFF0C\u540C\u4E00\u5929 minor +1\u3001\u8DE8\u5929\u91CD\u7F6E\u4E3A\u5F53\u5929 .1\uFF1Brevision \u4E0D\u4F1A\u91CD\u7F6E\uFF0C\u6BCF\u6B21\u5347\u7248\u53EA\u4F1A\u4E00\u76F4\u589E\u52A0\u3002",
      "`goals` \u53EA\u6539\u4F20\u5165\u7684\u76EE\u6807\uFF1Aproduct \u4EA7\u54C1\u76EE\u6807 / dev \u5F00\u53D1\u76EE\u6807 / research \u7814\u7A76\u76EE\u6807\uFF1B\u6BCF\u9879 { category, text, status }\uFF0Cstatus \u53D6 \u672A\u5F00\u59CB / \u8FDB\u884C\u4E2D / \u5DF2\u8FBE\u6210 / \u672A\u8FBE\u6210\u3002category \u662F\u76EE\u6807\u7C7B\u522B\uFF08\u7701\u7565\u65F6\u4ECE text \u5F00\u5934\u8BC6\u522B\uFF09\uFF0C\u63D0\u4F9B category \u65F6 text \u53EA\u5199\u300C\u73B0\u72B6 \u2026\uFF0C\u9884\u671F \u2026\u300D\u3002",
      "\u76EE\u6807\u6587\u672C\u56FA\u5B9A\u683C\u5F0F\uFF1A\u300C<\u7C7B\u522B> \u73B0\u72B6 <\u73B0\u5728\u600E\u6837>\uFF0C\u9884\u671F <\u8981\u53D8\u6210\u600E\u6837>\u3002\u300D\uFF0C\u7C7B\u522B\u5982 \u5E94\u7528\u529F\u80FD / \u5E94\u7528\u754C\u9762 / \u5E94\u7528\u670D\u52A1 / \u7B97\u6CD5 / \u6570\u636E / \u6027\u80FD / \u7A33\u5B9A\u6027 / \u5B89\u5168 / \u5DE5\u7A0B\u8D28\u91CF / \u4EA4\u4ED8 / \u2026\uFF1B\u4F8B\uFF1A\u5E94\u7528\u529F\u80FD \u73B0\u72B6 \u53EA\u80FD\u505A\u57FA\u7840\u5EFA\u6A21\uFF0C\u9884\u671F \u652F\u6301\u53C2\u6570\u5316\u7279\u5F81\u4E0E\u5386\u53F2\u56DE\u653E\u3002\u4E0D\u7B26\u5408\u65F6\u8C03\u7528\u88AB\u62D2\u7EDD\u3001\u72B6\u6001\u4E0D\u53D8\u3002",
      "`round` \u662F\u5B50\u9636\u6BB5\u8F6E\u6B21\uFF08\u7B2C\u51E0\u8F6E\u8FED\u4EE3\uFF09\uFF1A\u7701\u7565\u65F6 D \u8FDB\u5165 A \u81EA\u52A8 +1\uFF0C\u5176\u4ED6\u9636\u6BB5\u6CBF\u7528\u5F53\u524D\u8F6E\u6B21\uFF1B\u4E5F\u53EF\u4EE5\u663E\u5F0F\u6307\u5B9A\u3002",
      "`stage` \u7701\u7565\u65F6\u6CBF\u7528\u5F53\u524D\u9636\u6BB5\uFF08\u9996\u6B21\u8C03\u7528\u9ED8\u8BA4 A\uFF09\uFF0C\u53EA\u66F4\u65B0\u76EE\u6807\u72B6\u6001\u65F6\u53EF\u4EE5\u7701\u7565\u3002",
      "\u9636\u6BB5\u6309\u9879\u76EE\u76EE\u5F55\u4FDD\u5B58\uFF0C\u540C\u4E00\u5DE5\u4F5C\u533A\u7684\u4E3B\u5BF9\u8BDD\u5171\u4EAB\u3002\u6210\u5458\u4E0A\u4E0B\u6587\u4F1A\u63D0\u793A\u672C\u8F6E\u54EA\u4E9B\u6210\u5458\u8FD8\u6CA1\u6709\u53C2\u4E0E\u3001\u4EA7\u54C1\u7248\u672C\u7684\u76EE\u6807\u4E0E\u72B6\u6001\uFF0C\u4EE5\u53CA\u540E\u7EED\u53EF\u80FD\u8D70\u5411\uFF08\u5E26\u6761\u4EF6\u7684 set_product_stage \u8C03\u7528\uFF09\u3002",
      "\u6210\u5458\u7684\u6807\u51C6\u8EAB\u4EFD\u7531 set_member_scope \u7684 role \u8BBE\u7F6E\uFF08\u4EA7\u54C1\u7ECF\u7406 / \u7814\u7A76\u5458 / \u5F00\u53D1 / \u6D4B\u8BD5 / \u4E1A\u52A1\uFF09\uFF1B\u6CA1\u6709\u8BBE\u7F6E\u6807\u51C6\u8EAB\u4EFD\u7684\u6210\u5458\u4F1A\u5728\u9636\u6BB5\u6821\u9A8C\u4E2D\u88AB\u63D0\u793A\u3002",
      "\u6362\u9636\u6BB5\u6216\u5F00\u542F\u65B0\u4E00\u8F6E\uFF08\u6362 round\uFF09\u65F6\uFF0C\u5982\u679C\u672C\u8F6E\u8981\u6C42\u7684\u6210\u5458\u8FD8\u6CA1\u6709\u5168\u90E8\u53C2\u4E0E\uFF0C\u8C03\u7528\u4F1A\u88AB\u62D2\u7EDD\u4E14\u4E0D\u6539\u53D8\u72B6\u6001\uFF1A\u5148\u8BA9\u6210\u5458\u56DE\u590D\uFF0C\u518D\u91CD\u8BD5\u3002\u56DE\u5230\u4E0A\u4E00\u9636\u6BB5\u8FD4\u5DE5\u4E0D\u53D7\u6B64\u9650\u5236\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: ["A", "B", "C", "D"],
          description: "\u5927\u9636\u6BB5\uFF1AA \u8BA1\u5212\u4E0E\u76EE\u6807\u3001B \u5F00\u53D1\u4E0E\u6D4B\u8BD5\u3001C \u4EA7\u54C1\u7ECF\u7406\u4F7F\u7528\u3001D \u4E1A\u52A1\u4ECB\u5165\u3002"
        },
        round: {
          type: "integer",
          minimum: 1,
          maximum: 999,
          description: "\u5B50\u9636\u6BB5\u8F6E\u6B21\uFF08\u7B2C\u51E0\u8F6E\u8FED\u4EE3\uFF09\uFF1B\u7701\u7565\u65F6\u6309\u6D41\u7A0B\u81EA\u52A8\u51B3\u5B9A\u3002"
        },
        goals: {
          type: "object",
          additionalProperties: false,
          description: "\u4E09\u4E2A\u76EE\u6807\u53CA\u72B6\u6001\uFF0C\u53EA\u6539\u4F20\u5165\u7684\u9879\u3002",
          properties: {
            product: goalSchema("\u4EA7\u54C1\u76EE\u6807"),
            dev: goalSchema("\u5F00\u53D1\u76EE\u6807"),
            research: goalSchema("\u7814\u7A76\u76EE\u6807")
          }
        }
      },
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
      if (typeof service.productStage !== "function" || typeof service.setProductStage !== "function") {
        throw new Error("product stages are not available");
      }
      const cwd = projectDirOf(exec?.agent);
      if (cwd === "") throw new Error("set_product_stage needs a conversation with a project directory");
      const originSessionId = originSessionOf(exec.agent);
      if (isMemberSession(originSessionId)) {
        throw new Error("set_product_stage is only available in a main conversation; report the result back to the initiator");
      }
      const previous = await service.productStage(cwd);
      const planned = applyProductStage(previous, normalizeProductStageInput({
        stage: args.stage,
        round: args.round,
        goals: args.goals
      }));
      const tasks = await memberTasks.listForOrigin(originSessionId).catch(() => []);
      const scopes = await service.memberScopes().catch(() => ({}));
      if (isAdvancingProductStage(previous, planned)) {
        const blockers = productStageParticipationBlockers(previous, tasks, scopes);
        if (blockers.length > 0) {
          return {
            ok: false,
            text: formatProductStageBlocked(previous, planned, blockers),
            data: { blocked: true, state: previous, requested: planned, blockers, project: cwd }
          };
        }
      }
      const saved = await service.setProductStage({
        cwd,
        stage: args.stage,
        round: args.round,
        goals: args.goals,
        bySessionId: originSessionId
      });
      const warnings = productStageWarnings(saved.previous, tasks, scopes);
      return {
        ok: true,
        text: formatProductStageResult(saved.state, { created: previous === null, tasks, scopes, warnings }),
        data: {
          state: saved.state,
          previous: saved.previous,
          warnings,
          project: cwd
        }
      };
    }
  };
  const waitMemberDefinition = {
    name: "wait_member",
    description: [
      "\u7B49\u5F85\u7531 call_member \u53D1\u8D77\u7684\u6210\u5458\u4F1A\u8BDD\uFF0C\u6700\u591A timeoutMs \u6BEB\u79D2\u3002",
      "",
      "\u63A8\u8350\u7528 `all: true`\uFF1A\u7B49\u672C\u5BF9\u8BDD\u6240\u6709\u300C\u8FDB\u884C\u4E2D\u300D\u7684\u6210\u5458\u4F1A\u8BDD\uFF0C\u4EFB\u610F\u4E00\u4E2A\u5148\u6709\u65B0\u56DE\u590D\u6216\u8FDB\u5165\u7EC8\u6001\u5C31\u7ACB\u523B\u8FD4\u56DE\uFF0C",
      "\u5176\u4F59\u4F1A\u8BDD\u5728\u7ED3\u679C\u91CC\u5217\u51FA\uFF08\u4F1A\u8BDDid\u3001\u8FDB\u884C\u4E2D/\u7A7A\u95F2/\u5F02\u5E38\u4E2D\u6B62\u3001\u5DE5\u4F5C\u533A\u3001\u8F6E\u6B21\uFF09\u3002",
      "`conversationIds` \u6307\u5B9A\u8981\u7B49\u7684\u4F1A\u8BDDid\uFF1B`all` \u4E0E `conversationIds` \u4E92\u65A5\uFF0C\u540C\u65F6\u4F20\u4F1A\u62A5\u9519\u3002",
      "\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u4F1A\u8BDD\u65F6 `all: true` \u76F4\u63A5\u8FD4\u56DE ok\uFF0C\u5E76\u9644\u672C\u5BF9\u8BDD\u6240\u6709\u6210\u5458\u4F1A\u8BDD\u7684\u72B6\u6001\uFF0C\u4E0D\u62A5\u9519\u3002",
      "\u6BCF\u6B21\u8FD4\u56DE\u90FD\u5E26 `conversations`\uFF1A\u672C\u5BF9\u8BDD\u8DDF\u8E2A\u7684\u6240\u6709\u4F1A\u8BDDid\u3001\u72B6\u6001\u548C\u5DE5\u4F5C\u533A\uFF1B\u5F53\u524D\u8FD4\u56DE\u7684\u4F1A\u8BDD\u5E26 current \u6807\u8BB0\u3002",
      "\u6210\u5458\u5BF9\u8BDD\u4E00\u6709\u65B0\u56DE\u590D\uFF08\u4E00\u8F6E\u7ED3\u675F\uFF09\u5C31\u7ACB\u523B\u8FD4\u56DE\uFF0C\u4E0D\u7B49\u5230\u6574\u6BB5\u4EFB\u52A1\u7ED3\u675F\uFF1B\u8FD4\u56DE\u503C\u5E26 state\uFF1A",
      "progress\uFF1A\u672C\u8F6E\u56DE\u590D\u5DF2\u8FD4\u56DE\uFF0C\u4F46\u6210\u5458\u8FD8\u4F1A\u7EE7\u7EED\uFF08\u53EF\u80FD\u8FD8\u6709\u672A\u5B8C\u6210\u7684\u5B50\u4EE3\u7406\uFF09\uFF1B\u7EE7\u7EED\u7528 wait_member \u7B49\u4E0B\u4E00\u8F6E\u3002",
      "done\uFF1A\u6574\u6BB5\u4EFB\u52A1\u5B8C\u6210\uFF0C\u8FD4\u56DE\u6700\u7EC8\u6587\u672C\u3001\u4F1A\u8BDDid\u548C\u5F53\u524D\u4E0A\u4E0B\u6587\u5360\u7528\u3002",
      "\u8D85\u65F6\uFF1Adone=false\u3001state=running\uFF0C\u7528 all: true\uFF08\u6216 conversationIds\uFF09\u7EE7\u7EED\u7B49\u5373\u53EF\uFF0C\u671F\u95F4\u4EA7\u751F\u7684\u56DE\u590D\u4E0D\u4F1A\u4E22\u3002",
      "\u5931\u8D25/\u4E2D\u65AD\uFF1A\u8FD4\u56DE\u9519\u8BEF\uFF1B\u76EE\u6807 DSH \u91CD\u542F\u65F6\u53EF\u4EE5\u7528 call_member \u5E26 conversationId \u7EE7\u7EED\u8BE5\u5BF9\u8BDD\u3002",
      "\u5982\u679C\u51B3\u5B9A\u4E0D\u518D\u7EE7\u7EED\u7B49\uFF1A\u5BF9\u8BDD\u5B8C\u6210\uFF08\u6216\u5931\u8D25/\u4E2D\u65AD\uFF09\u540E\uFF0C3 \u79D2\u5185\u6CA1\u6709 wait_member \u53D6\u8D70\u7ED3\u679C\uFF0C",
      "\u63D2\u4EF6\u53EA\u628A\u5C1A\u672A\u53D6\u8D70\u7684\u56DE\u590D\u6295\u9012\u56DE\u53D1\u8D77\u5BF9\u8BDD\uFF1B\u5DF2\u7ECF\u53D6\u8D70\u7684\u7ED3\u679C\uFF08\u5305\u62EC\u672C\u8F6E\u6587\u672C\uFF09\u4E0D\u4F1A\u91CD\u590D\u6295\u9012\u3002",
      "\u53D1\u8D77\u5BF9\u8BDD\u5F53\u65F6\u6B63\u5728\u6267\u884C turn \u65F6\uFF0C\u8FD9\u6761\u7ED3\u679C\u4F1A\u76F4\u63A5\u63D2\u5165\u5F53\u524D turn\uFF08\u4E0D\u7B49 turn \u7ED3\u675F\uFF09\u3002",
      "state=done \u65F6\u53EF\u4EE5\u7528\u8FD4\u56DE\u7684\u4F1A\u8BDDid\u7EE7\u7EED\u6295\u9012\uFF1Acall_member { conversationId, prompt }\uFF1B",
      "\u7ED3\u679C\u91CC\u4F1A\u663E\u793A\u76EE\u6807\u5BF9\u8BDD\u7684\u4E0A\u4E0B\u6587\u5360\u6BD4\uFF1B\u8D85\u8FC7\u8BE5\u4F1A\u8BDD\u7684\u538B\u7F29\u9608\u503C\u65F6\uFF0C\u4E0B\u6B21 call_member \u6295\u9012\u524D\u4F1A\u81EA\u52A8\u538B\u7F29",
      "\u6BCF\u6B21\u8C03\u7528\u6709\u4E0A\u9650\uFF08\u9ED8\u8BA4 30000\uFF0C\u6700\u5927 300000 \u6BEB\u79D2\uFF09\uFF0C\u4E0D\u4F1A\u65E0\u9650\u963B\u585E\uFF1B\u7528\u6237\u505C\u6B62\u5F53\u524D\u5BF9\u8BDD\u4F1A\u4E2D\u6B62\u672C\u6B21\u7B49\u5F85\u3002",
      "\u672C\u5BF9\u8BDD\u53EF\u4EE5\u7528 set_member_scope \u7684 waitMember:false \u5173\u95ED\u7B49\u5F85\uFF1B\u5173\u95ED\u540E\u672C\u5DE5\u5177\u8FD4\u56DE ok:false\uFF0C\u6210\u5458\u56DE\u590D\u4ECD\u4F1A\u81EA\u52A8\u6295\u9012\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description: "\u7B49\u672C\u5BF9\u8BDD\u6240\u6709\u8FDB\u884C\u4E2D\u7684\u6210\u5458\u4F1A\u8BDD\uFF08\u63A8\u8350\uFF09\u3002\u4EFB\u610F\u4E00\u4E2A\u5148\u6709\u56DE\u590D/\u7EC8\u6001\u5C31\u7ACB\u523B\u8FD4\u56DE\uFF1B\u4E0E conversationIds \u4E92\u65A5\u3002"
        },
        conversationIds: {
          type: "array",
          items: { type: "string" },
          description: "\u6307\u5B9A\u8981\u7B49\u7684\u4F1A\u8BDDid\uFF08call_member \u8FD4\u56DE\uFF09\uFF1A\u4EFB\u610F\u4E00\u4E2A\u5148\u6709\u6D88\u606F\u5C31\u7ACB\u523B\u8FD4\u56DE\uFF0C\u5176\u4F59\u4F1A\u8BDD\u5728\u8FD4\u56DE\u503C\u91CC\u5217\u51FA\u3002\u63A8\u8350\u6539\u7528 all: true\u3002"
        },
        timeoutMs: { type: "integer", minimum: 1e3, maximum: 3e5, description: "\u672C\u6B21\u7B49\u5F85\u4E0A\u9650\uFF0C\u9ED8\u8BA4 30000 \u6BEB\u79D2\u3002" }
      },
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
      const originSessionId = originSessionOf(exec.agent);
      const waitScope = typeof service.memberScope === "function" ? await service.memberScope(originSessionId).catch(() => null) : null;
      if (waitScope?.waitMember === false) {
        return {
          ok: false,
          text: [
            'wait_member \u5DF2\u88AB\u5173\u95ED\uFF08set_member_scope { "waitMember": false }\uFF09\uFF0C\u672C\u6B21\u6CA1\u6709\u7B49\u5F85\u3002',
            "\u6210\u5458\u7684\u7ED3\u679C\u4ECD\u4F1A\u81EA\u52A8\u6295\u9012\u5230\u672C\u5BF9\u8BDD\uFF1B\u9700\u8981\u7B49\u5F85\u65F6\u8BA9\u7528\u6237\u628A waitMember \u6253\u5F00\u3002"
          ].join("\n"),
          data: { disabled: true, waitMember: false }
        };
      }
      if (typeof args.conversationId === "string" && args.conversationId.trim() !== "") {
        throw new Error('wait_member \u4E0D\u518D\u63A5\u53D7 conversationId\uFF1A\u53EA\u7B49\u4E00\u4E2A\u4F1A\u8BDD\u7528 conversationIds: ["<\u4F1A\u8BDDid>"]\uFF1B\u7B49\u5168\u90E8\u8FDB\u884C\u4E2D\u7684\u4F1A\u8BDD\u7528 all: true');
      }
      const ids = requestedConversationIds(args);
      const wantsAll = args.all === true;
      if (wantsAll && ids.length > 0) {
        throw new Error("all \u548C conversationIds \u4E92\u65A5\uFF1A\u7B49\u5168\u90E8\u8FDB\u884C\u4E2D\u7684\u4F1A\u8BDD\u53EA\u4F20 all: true\uFF1B\u53EA\u7B49\u5176\u4E2D\u51E0\u4E2A\u5C31\u53EA\u4F20 conversationIds");
      }
      const watched = wantsAll ? (await memberTasks.inFlightForOrigin(originSessionId)).map((task2) => String(task2.conversationId)) : ids;
      if (wantsAll && watched.length === 0) {
        const conversationBlock2 = await originConversationBlock(memberTasks, originSessionId, void 0);
        return {
          ok: true,
          text: [
            "\u672C\u5BF9\u8BDD\u5F53\u524D\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6210\u5458\u4F1A\u8BDD\uFF0C\u4E0D\u9700\u8981\u7B49\u5F85\u3002",
            ...conversationBlock2.lines
          ].join("\n"),
          data: {
            all: true,
            waiting: false,
            done: true,
            timedOut: false,
            state: "idle",
            conversationIds: [],
            conversations: conversationBlock2.conversations
          }
        };
      }
      if (watched.length === 0) {
        throw new Error("conversationIds is required (or set all: true to wait for every running member conversation)");
      }
      if (watched.length === 1) {
        const result2 = await memberTasks.wait(watched[0], { timeoutMs, signal: exec.signal });
        const task2 = result2.task;
        const replies2 = Array.isArray(result2.replies) ? result2.replies : [];
        const replyText2 = replies2.map((reply) => reply.text).join("\n\n").trim();
        const conversationBlock2 = await originConversationBlock(memberTasks, originSessionId, task2.conversationId);
        const data2 = {
          ...memberTaskData(task2, memberTasks),
          all: wantsAll,
          conversationIds: watched,
          currentConversationId: task2.conversationId,
          conversations: conversationBlock2.conversations,
          done: result2.done,
          timedOut: result2.timedOut,
          state: result2.state,
          text: replyText2,
          replies: replies2
        };
        const turn2 = Number.isSafeInteger(task2.turns) && task2.turns > 0 ? `\u7B2C ${String(task2.turns)} \u8F6E` : "";
        const where2 = `${task2.member}\uFF08${task2.memberIp}\uFF09`;
        const contextLine = formatContextLine(task2.context);
        const advice = formatCompactionAdvice(task2.context, await compressThresholdFor(service, task2.conversationId));
        if (result2.state === "archived" || task2.status === "archived") {
          return {
            ok: true,
            text: `\u6210\u5458\u4F1A\u8BDD ${task2.conversationId} \u5DF2\u5F52\u6863\uFF0C\u4E0D\u518D\u8DDF\u8E2A\uFF1B\u8981\u6062\u590D\u8BF7\u5728\u6210\u5458 Web UI \u53D6\u6D88\u5F52\u6863\u3002`,
            data: data2
          };
        }
        if (!result2.done && result2.state === "progress") {
          return {
            ok: true,
            text: [
              `\u6210\u5458\u4F1A\u8BDD ${task2.conversationId} \u8FDB\u884C\u4E2D${turn2 === "" ? "" : `\uFF08${turn2}\uFF0C\u5C1A\u672A\u7ED3\u675F\uFF09`}\uFF1A${where2}\u3002`,
              replyText2 !== "" ? `\u672C\u8F6E\u56DE\u590D\uFF1A
${replyText2}` : "",
              "\u6210\u5458\u8FD8\u4F1A\u7EE7\u7EED\uFF08\u53EF\u80FD\u8FD8\u6709\u5B50\u4EE3\u7406\u5728\u8DD1\uFF09\uFF0C\u8FD9\u4E0D\u662F\u6700\u7EC8\u7ED3\u679C\u3002",
              contextLine,
              ...conversationBlock2.lines,
              `\u65E5\u5FD7\uFF1A${data2.logFile}`
            ].filter((line) => line !== "").join("\n"),
            data: data2
          };
        }
        if (result2.done && task2.status === "completed") {
          const terminal = terminalResultText(task2, replyText2);
          return {
            ok: true,
            text: [
              `\u6210\u5458\u4F1A\u8BDD ${task2.conversationId} \u5DF2\u5B8C\u6210\uFF1A${where2}\u3002`,
              "\uFF08\u4EFB\u52A1\u5DF2\u7ED3\u675F\uFF1B\u8981\u7EE7\u7EED\u8FD9\u4E2A\u5BF9\u8BDD\u7528 call_member \u5E26 conversationId\u3002\uFF09",
              `\u4F1A\u8BDDid\uFF1A${task2.conversationId}`,
              `\u7EE7\u7EED\u8FD9\u4E2A\u5BF9\u8BDD\uFF1Acall_member { "member": ${JSON.stringify(String(task2.member))}, "conversationId": ${JSON.stringify(String(task2.conversationId))}, "prompt": "..." }`,
              contextLine,
              advice,
              "\u7ED3\u679C\uFF1A",
              terminal.text !== "" ? terminal.text : terminal.alreadyDelivered ? "\uFF08\u8FD9\u6761\u56DE\u590D\u5DF2\u7531\u5B8C\u6210\u6D88\u606F\u6295\u9012\u5230\u672C\u5BF9\u8BDD\uFF0C\u8FD9\u91CC\u4E0D\u518D\u91CD\u590D\u6B63\u6587\u3002\uFF09" : terminal.alreadyReturned ? "\uFF08\u8FD9\u6761\u56DE\u590D\u5DF2\u7ECF\u7531\u5148\u524D\u7684\u7B49\u5F85\u8FD4\u56DE\uFF0C\u8FD9\u91CC\u4E0D\u518D\u91CD\u590D\u6B63\u6587\u3002\uFF09" : "(\u6210\u5458\u6CA1\u6709\u8FD4\u56DE\u6587\u672C\u7ED3\u679C)",
              ...conversationBlock2.lines,
              `\u65E5\u5FD7\uFF1A${data2.logFile}`
            ].filter((line) => line !== "").join("\n"),
            data: { ...data2, fallbackDelivered: terminal.alreadyDelivered, textAlreadyReturned: terminal.alreadyReturned }
          };
        }
        if (!result2.done) {
          const effective2 = Math.min(3e5, Math.max(1e3, timeoutMs));
          return {
            ok: true,
            text: [
              `\u6210\u5458\u4F1A\u8BDD ${task2.conversationId} \u4ECD\u5728\u8FD0\u884C${turn2 === "" ? "" : `\uFF08${turn2}\uFF0C\u5C1A\u672A\u7ED3\u675F\uFF09`}\uFF1A${where2}\u3002`,
              "\u8FD9\u6BB5\u65F6\u95F4\u6CA1\u6709\u65B0\u56DE\u590D\uFF0C\u4F46\u4EFB\u52A1\u6CA1\u6709\u7ED3\u675F\u3001\u671F\u95F4\u7684\u56DE\u590D\u4E5F\u4E0D\u4F1A\u4E22\u3002",
              contextLine,
              typeof task2.lastText === "string" && task2.lastText !== "" ? `\u6700\u8FD1\u8F93\u51FA\uFF1A${task2.lastText.slice(0, 500)}` : "",
              ...conversationBlock2.lines,
              `\u65E5\u5FD7\uFF1A${data2.logFile}`
            ].filter((line) => line !== "").join("\n"),
            data: data2
          };
        }
        return {
          ok: false,
          text: [
            `\u6210\u5458\u4F1A\u8BDD ${task2.conversationId} ${task2.status}\uFF08\u5DF2\u7ED3\u675F\uFF09\uFF1A${where2}\u3002`,
            `\u4F1A\u8BDDid\uFF1A${task2.conversationId}`,
            `\u539F\u56E0\uFF1A${task2.error ?? "unknown"}`,
            replyText2 !== "" ? `\u4E2D\u65AD\u524D\u7684\u56DE\u590D\uFF1A
${replyText2}` : "",
            task2.interrupted === true ? "\u76EE\u6807\u6210\u5458\u7684 DSH \u91CD\u542F\u6216\u8FD0\u884C\u65F6\u9000\u51FA\u6253\u65AD\u4E86\u8FD9\u4E00\u8F6E\uFF1B\u53EF\u4EE5\u7528 call_member \u5E26\u540C\u4E00\u4E2A conversationId \u7EE7\u7EED\u3002" : "",
            contextLine,
            ...conversationBlock2.lines,
            `\u65E5\u5FD7\uFF1A${data2.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data: data2
        };
      }
      const result = await memberTasks.waitAny(watched, { timeoutMs, signal: exec.signal });
      const task = result.task;
      const replies = Array.isArray(result.replies) ? result.replies : [];
      const replyText = replies.map((reply) => reply.text).join("\n\n").trim();
      const remaining = Array.isArray(result.remaining) ? result.remaining : [];
      const conversationBlock = await originConversationBlock(memberTasks, originSessionId, task.conversationId);
      const data = {
        ...memberTaskData(task, memberTasks),
        all: wantsAll,
        conversationIds: watched,
        currentConversationId: task.conversationId,
        conversations: conversationBlock.conversations,
        done: result.done,
        timedOut: result.timedOut,
        state: result.state,
        text: replyText,
        replies,
        remaining
      };
      const effective = Math.min(3e5, Math.max(1e3, timeoutMs));
      const remainingHint = formatRemainingWait(remaining);
      const where = `${task.member}\uFF08${task.memberIp}\uFF09`;
      const turn = Number.isSafeInteger(task.turns) && task.turns > 0 ? `\u7B2C ${String(task.turns)} \u8F6E` : "";
      if (result.state === "archived" || task.status === "archived") {
        return {
          ok: true,
          text: `\u6210\u5458\u4F1A\u8BDD ${task.conversationId} \u5DF2\u5F52\u6863\uFF0C\u4E0D\u518D\u8DDF\u8E2A\uFF1B\u8981\u6062\u590D\u8BF7\u5728\u6210\u5458 Web UI \u53D6\u6D88\u5F52\u6863\u3002`,
          data
        };
      }
      if (!result.done && result.state === "progress") {
        return {
          ok: true,
          text: [
            `\u6210\u5458\u4F1A\u8BDD ${task.conversationId} \u6709\u65B0\u7684\u8FDB\u5C55${turn === "" ? "" : `\uFF08${turn}\uFF0C\u5C1A\u672A\u7ED3\u675F\uFF09`}\uFF1A${where}\u3002`,
            replyText !== "" ? `\u672C\u8F6E\u56DE\u590D\uFF1A
${replyText}` : "",
            "\u672C\u6B21\u53EA\u8FD4\u56DE\u4E86\u6700\u5148\u6709\u6D88\u606F\u7684\u90A3\u4E2A\u4F1A\u8BDD\uFF1B\u8FD9\u4E0D\u662F\u6700\u7EC8\u7ED3\u679C\uFF0C\u8FD8\u8981\u7EE7\u7EED\u7B49\u3002",
            formatContextLine(task.context),
            ...remainingHint,
            ...conversationBlock.lines,
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data
        };
      }
      if (result.done && task.status === "completed") {
        const terminal = terminalResultText(task, replyText);
        return {
          ok: true,
          text: [
            `\u6210\u5458\u4F1A\u8BDD ${task.conversationId} \u5DF2\u5B8C\u6210\uFF1A${where}\u3002`,
            "\uFF08\u8FD9\u4E2A\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u4E0D\u9700\u8981\u518D\u7B49\u5B83\uFF1B\u8981\u7EE7\u7EED\u8FD9\u4E2A\u5BF9\u8BDD\u7528 call_member \u5E26 conversationId\u3002\uFF09",
            `\u4F1A\u8BDDid\uFF1A${task.conversationId}`,
            `\u7EE7\u7EED\u8FD9\u4E2A\u5BF9\u8BDD\uFF1Acall_member { "member": ${JSON.stringify(String(task.member))}, "conversationId": ${JSON.stringify(String(task.conversationId))}, "prompt": "..." }`,
            formatContextLine(task.context),
            formatCompactionAdvice(task.context, await compressThresholdFor(service, task.conversationId)),
            "\u7ED3\u679C\uFF1A",
            terminal.text !== "" ? terminal.text : terminal.alreadyDelivered ? "\uFF08\u8FD9\u6761\u56DE\u590D\u5DF2\u7531\u5B8C\u6210\u6D88\u606F\u6295\u9012\u5230\u672C\u5BF9\u8BDD\uFF0C\u8FD9\u91CC\u4E0D\u518D\u91CD\u590D\u6B63\u6587\u3002\uFF09" : terminal.alreadyReturned ? "\uFF08\u8FD9\u6761\u56DE\u590D\u5DF2\u7ECF\u7531\u5148\u524D\u7684\u7B49\u5F85\u8FD4\u56DE\uFF0C\u8FD9\u91CC\u4E0D\u518D\u91CD\u590D\u6B63\u6587\u3002\uFF09" : "(\u6210\u5458\u6CA1\u6709\u8FD4\u56DE\u6587\u672C\u7ED3\u679C)",
            ...remainingHint,
            ...conversationBlock.lines,
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data: { ...data, fallbackDelivered: terminal.alreadyDelivered, textAlreadyReturned: terminal.alreadyReturned }
        };
      }
      if (result.timedOut) {
        return {
          ok: true,
          text: [
            `\u7B49\u5F85\u8D85\u65F6\uFF1A${String(watched.length)} \u4E2A\u4F1A\u8BDD\u5728 ${String(effective)} \u6BEB\u79D2\u5185\u90FD\u6CA1\u6709\u65B0\u56DE\u590D\u3002`,
            "\u4EFB\u52A1\u90FD\u6CA1\u6709\u7ED3\u675F\uFF0C\u671F\u95F4\u7684\u56DE\u590D\u4E5F\u4E0D\u4F1A\u4E22\u3002",
            ...remainingHint,
            ...conversationBlock.lines,
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data
        };
      }
      return {
        ok: false,
        text: [
          `\u6210\u5458\u4F1A\u8BDD ${task.conversationId} ${task.status}\uFF08\u5DF2\u7ED3\u675F\uFF09\uFF1A${where}\u3002`,
          `\u4F1A\u8BDDid\uFF1A${task.conversationId}`,
          `\u539F\u56E0\uFF1A${task.error ?? "unknown"}`,
          replyText !== "" ? `\u4E2D\u65AD\u524D\u7684\u56DE\u590D\uFF1A
${replyText}` : "",
          task.interrupted === true ? "\u76EE\u6807\u6210\u5458\u7684 DSH \u91CD\u542F\u6216\u8FD0\u884C\u65F6\u9000\u51FA\u6253\u65AD\u4E86\u8FD9\u4E00\u8F6E\uFF1B\u53EF\u4EE5\u7528 call_member \u5E26\u540C\u4E00\u4E2A conversationId \u7EE7\u7EED\u3002" : "",
          formatContextLine(task.context),
          ...remainingHint,
          ...conversationBlock.lines,
          `\u65E5\u5FD7\uFF1A${data.logFile}`
        ].filter((line) => line !== "").join("\n"),
        data
      };
    }
  };
  const statusMemberDefinition = {
    name: "status_member",
    description: [
      "\u67E5\u770B\u4E00\u4E2A\u6216\u591A\u4E2A\u6210\u5458\u4F1A\u8BDD\u7684\u5F53\u524D\u72B6\u6001\uFF0C\u4EE5\u53CA\u8FD9\u4E9B\u76EE\u6807\u5BF9\u8BDD\u6700\u8FD1\u4E24\u6B21\u7684\u7528\u6237\u6D88\u606F\uFF08\u5C31\u662F call_member \u6295\u9012\u8FC7\u53BB\u7684\u6D88\u606F\uFF09\u3002",
      "",
      "`conversationId` \u67E5\u4E00\u4E2A\uFF0C`conversationIds` \u4E00\u6B21\u67E5\u591A\u4E2A\uFF08\u8FD4\u56DE\u6309\u4F1A\u8BDD\u5206\u5757\u5217\u51FA\uFF0C\u5E76\u5E26\u4E00\u884C\u6C47\u603B\uFF09\u3002",
      "\u8FD4\u56DE\u503C\u540C\u65F6\u5217\u51FA\u672C\u5BF9\u8BDD\u8DDF\u8E2A\u7684**\u6240\u6709**\u6210\u5458\u4F1A\u8BDD\uFF1A\u6BCF\u4E2A\u4F1A\u8BDD\u7684id\u3001\u72B6\u6001\uFF08\u8FDB\u884C\u4E2D / \u7A7A\u95F2 / \u5F02\u5E38\u4E2D\u6B62\uFF09\u3001\u5DE5\u4F5C\u533A\u540D\u79F0\u3001\u8EAB\u4EFD\u548C\u5DE5\u4F5C\u8303\u56F4\u3002",
      "\u8EAB\u4EFD/\u5DE5\u4F5C\u8303\u56F4\u7F3A\u5931\uFF08\u5305\u62EC\u5347\u7EA7\u524D\u521B\u5EFA\u3001\u6CA1\u6709 profile \u5FEB\u7167\u7684\u8001\u4F1A\u8BDD\uFF09\u4F1A\u6807\u6210\u300C\u672A\u8BBE\u7F6E\u300D\uFF0C\u5E76\u5728\u672B\u5C3E\u63D0\u793A\u4E0B\u6B21 call_member \u7528 identity \u548C scope \u53C2\u6570\u8865\u9F50\u3002",
      "\u72B6\u6001\u4F18\u5148\u53D6\u76EE\u6807\u6210\u5458\u7684\u6700\u65B0\u6295\u5F71\uFF1A\u8FDB\u884C\u4E2D / \u7A7A\u95F2 / \u5F02\u5E38\u4E2D\u6B62 / \u51FA\u9519\uFF1B\u76EE\u6807\u4E0D\u53EF\u8FBE\u65F6\u9000\u56DE\u672C\u673A\u4EFB\u52A1\u72B6\u6001\u3002",
      "\u6700\u8FD1\u4E24\u6B21\u7528\u6237\u6D88\u606F\u6765\u81EA\u672C\u673A\u4EFB\u52A1\u8BB0\u5F55\uFF0C\u6309\u6295\u9012\u65F6\u95F4\u4ECE\u65E7\u5230\u65B0\u6392\u5217\uFF0C\u6700\u591A\u4E24\u6761\uFF1B",
      "\u6700\u8FD1\u4E00\u6B21\u601D\u8003\u662F\u76EE\u6807\u5BF9\u8BDD\u6700\u65B0\u4E00\u8F6E\u7684 reasoning\uFF1B\u53EA\u8DDF\u8E2A\u672C\u673A\u53D1\u8D77\u6216\u7EE7\u7EED\u8FC7\u7684\u4F1A\u8BDD\uFF0C\u6CA1\u6709\u8DDF\u8E2A\u7684\u4F1A\u8BDD\u4F1A\u660E\u786E\u62A5\u9519\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "\u8981\u67E5\u770B\u7684\u6210\u5458\u4F1A\u8BDDid\uFF08call_member \u8FD4\u56DE\uFF09\u3002\u67E5\u4E00\u4E2A\u65F6\u7528\u5B83\u3002" },
        conversationIds: {
          type: "array",
          items: { type: "string" },
          description: "\u4E00\u6B21\u67E5\u770B\u591A\u4E2A\u6210\u5458\u4F1A\u8BDDid\uFF1B\u8FD4\u56DE\u6BCF\u4E2A\u4F1A\u8BDD\u7684\u72B6\u6001\u3001\u6700\u8FD1\u4E24\u6B21\u7528\u6237\u6D88\u606F\u548C\u6700\u8FD1\u4E00\u6B21\u601D\u8003\u3002"
        }
      },
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
      const ids = requestedConversationIds(args);
      if (ids.length === 0) throw new Error("conversationId is required");
      const inspected = await Promise.all(ids.map(async (id) => {
        try {
          return { id, found: await memberTasks.inspect(id) };
        } catch {
          return { id, found: null };
        }
      }));
      const missing = inspected.filter((entry) => entry.found === null).map((entry) => entry.id);
      const archived = inspected.filter((entry) => entry.found !== null && entry.found.archived === true).map((entry) => entry.id);
      const scopes = typeof service.memberScopes === "function" ? await service.memberScopes().catch(() => ({})) : {};
      const entries = inspected.filter((entry) => entry.found !== null && entry.found.archived !== true).map((entry) => describeStatus(entry.found, memberTasks, scopes));
      if (entries.length === 0) {
        if (archived.length > 0) {
          return {
            ok: true,
            text: `\u5DF2\u5F52\u6863\uFF0C\u4E0D\u518D\u5217\u51FA\uFF1A${archived.join("\u3001")}\u3002`,
            data: { count: 0, requestedCount: 0, conversations: [], requested: [], missing, archived }
          };
        }
        throw new Error(`\u672C\u673A\u6CA1\u6709\u8DDF\u8E2A\u4F1A\u8BDD ${missing.join("\u3001")}\uFF1B\u5148\u7528 call_member \u53D1\u8D77\u6216\u7EE7\u7EED\u4E00\u6B21\uFF0C\u518D\u67E5\u72B6\u6001\u3002`);
      }
      const requestedOrigin = inspected.find((entry) => entry.found !== null)?.found?.task?.originSessionId ?? "";
      let originId = originSessionOf(exec?.agent) || requestedOrigin;
      let allBlock = await originConversationBlock(memberTasks, originId, ids[0], { withProfile: true, scopes });
      if (allBlock.conversations.length === 0 && requestedOrigin !== "" && requestedOrigin !== originId) {
        originId = requestedOrigin;
        allBlock = await originConversationBlock(memberTasks, originId, ids[0], { withProfile: true, scopes });
      }
      const missingProfileHint = formatMemberScopeMissingHint(allBlock.conversations, scopes);
      const allLines = allBlock.conversations.length === 0 ? ["\uFF08\u672C\u5BF9\u8BDD\u4EFB\u52A1\u8868\u91CC\u6CA1\u6709\u53EF\u5217\u51FA\u7684\u4F1A\u8BDD\u3002\uFF09"] : [
        ...allBlock.lines,
        "\uFF08\u5168\u91CF\u5217\u8868\u7684\u72B6\u6001/\u5DE5\u4F5C\u533A\u6765\u81EA\u672C\u673A\u4EFB\u52A1\u8BB0\u5F55\uFF1B\u88AB\u67E5\u4F1A\u8BDD\u8BE6\u60C5\u4F18\u5148\u5B9E\u65F6\u3002\uFF09",
        ...missingProfileHint === "" ? [] : [missingProfileHint]
      ];
      if (entries.length === 1 && missing.length === 0) {
        return {
          ok: true,
          text: [formatStatusBlock(entries[0]), "", ...allLines, ...archived.length === 0 ? [] : [`\u5DF2\u5F52\u6863\uFF0C\u4E0D\u518D\u5217\u51FA\uFF1A${archived.join("\u3001")}\u3002`]].join("\n"),
          data: {
            ...statusData(entries[0]),
            count: allBlock.conversations.length,
            requestedCount: 1,
            conversations: allBlock.conversations,
            requested: entries.map(statusData),
            archived
          }
        };
      }
      const counts = /* @__PURE__ */ new Map();
      for (const entry of entries) counts.set(entry.statusLabel, (counts.get(entry.statusLabel) ?? 0) + 1);
      const parts = [
        `\u6210\u5458\u4F1A\u8BDD\u72B6\u6001\uFF1A\u5171 ${String(entries.length)} \u4E2A\uFF08${[...counts].map(([label, count]) => `${label} ${String(count)}`).join("\uFF0C")}\uFF09`
      ];
      entries.forEach((entry, index) => {
        const lines = formatStatusBlock(entry).split("\n");
        parts.push("", lines.map((line, lineIndex) => lineIndex === 0 ? `[${String(index + 1)}] ${line}` : line).join("\n"));
      });
      if (missing.length > 0) {
        parts.push("", `\u672C\u673A\u6CA1\u6709\u8DDF\u8E2A\u8FD9\u4E9B\u4F1A\u8BDD\uFF1A${missing.join("\u3001")}\uFF1B\u5148\u7528 call_member \u53D1\u8D77\u6216\u7EE7\u7EED\u4E00\u6B21\uFF0C\u518D\u67E5\u72B6\u6001\u3002`);
      }
      if (archived.length > 0) {
        parts.push("", `\u5DF2\u5F52\u6863\uFF0C\u4E0D\u518D\u5217\u51FA\uFF1A${archived.join("\u3001")}\u3002`);
      }
      parts.push("", ...allLines);
      return {
        ok: true,
        text: parts.join("\n"),
        data: {
          count: allBlock.conversations.length,
          requestedCount: entries.length,
          conversations: allBlock.conversations,
          requested: entries.map(statusData),
          missing,
          archived
        }
      };
    }
  };
  const removeMemberDefinition = {
    name: "remove_member",
    description: [
      "\u5B8C\u5168\u5220\u9664\u76EE\u6807\u6210\u5458\u4E0A\u7684\u4E00\u4E2A\u5BF9\u8BDD\uFF1A\u5F52\u6863 \u2192 \u5220\u9664\u5BF9\u8BDD \u2192 \u5220\u9664\u5DE5\u4F5C\u533A\u8BB0\u5F55 \u2192 \u6E05\u7A7A\u5E76\u5220\u9664\u5DE5\u4F5C\u533A\u76EE\u5F55\uFF0C\u5E76\u505C\u6B62\u672C\u673A\u5BF9\u5B83\u7684\u8DDF\u8E2A\u3002",
      "",
      "`conversationId` \u5FC5\u586B\uFF1A`call_member` / `wait_member` \u8FD4\u56DE\u7684\u4F1A\u8BDDid\uFF0C\u6216\u672C\u673A\u8DDF\u8E2A\u8FC7\u7684\u4EFB\u4F55\u6210\u5458\u4F1A\u8BDD\uFF1B\u76EE\u6807\u6210\u5458\u7531\u672C\u673A\u4EFB\u52A1\u8BB0\u5F55\u89E3\u6790\uFF0C\u6CA1\u8DDF\u8E2A\u8FC7\u7684\u4F1A\u8BDD\u4F1A\u62A5\u9519\u3002",
      "\u987A\u5E8F\u56FA\u5B9A\uFF1A\u5148\u5728\u6210\u5458\u4E0A\u5F52\u6863\uFF08\u505C\u6B62\u6B63\u5728\u8DD1\u7684\u5DE5\u4F5C\u3001\u628A\u4F1A\u8BDD\u79FB\u51FA Web \u5217\u8868\uFF09\uFF0C\u518D\u5220\u9664 interop \u5BF9\u8BDD\u8BB0\u5F55\uFF0C\u518D\u5220\u9664\u5DE5\u4F5C\u533A\u8BB0\u5F55\uFF0C\u6700\u540E\u9012\u5F52\u6E05\u7A7A\u5E76\u5220\u9664\u5DE5\u4F5C\u533A\u76EE\u5F55\u3002",
      "\u5220\u9664\u540E\u8FD9\u4E2A\u4F1A\u8BDDid \u4E0D\u80FD\u518D\u6295\u9012\uFF0C\u5B83\u5360\u7528\u7684\u5DE5\u4F5C\u533A\u540D\u4E5F\u4F1A\u7A7A\u51FA\u6765\uFF0C\u53EF\u4EE5\u91CD\u65B0\u7528\u540C\u540D workspace \u53D1\u8D77\u65B0\u5BF9\u8BDD\u3002",
      "\u5DE5\u4F5C\u533A\u76EE\u5F55\u53EA\u6709\u5728\u6210\u5458\u7684\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\uFF08~/.dsh/workspaces\uFF09\u4E4B\u4E0B\u624D\u4F1A\u88AB\u5220\u9664\uFF1B\u9ED8\u8BA4\u5DE5\u4F5C\u533A\u53EF\u80FD\u6307\u5411 Documents \u4E4B\u7C7B\u7684\u7528\u6237\u76EE\u5F55\uFF0C\u90A3\u79CD\u60C5\u51B5\u53EA\u5220\u8BB0\u5F55\u3001\u4E0D\u5220\u76EE\u5F55\u3002",
      "\u6210\u5458\u4FA7\u53EF\u80FD\u56E0\u7248\u672C\u65E7\u3001\u4E0D\u53EF\u8FBE\u3001\u76EE\u5F55\u5360\u7528\u7B49\u539F\u56E0\u65E0\u6CD5\u5F52\u6863/\u5220\u9664\uFF1B\u65E0\u8BBA\u6210\u5458\u4FA7\u7ED3\u679C\u5982\u4F55\uFF0C\u672C\u673A\u4EFB\u52A1\u8BB0\u5F55\u548C\u65E5\u5FD7\u90FD\u4F1A\u88AB\u5220\u9664\uFF0C\u672C\u673A\u4E0D\u518D\u8DDF\u8E2A\u8FD9\u4E2A\u4F1A\u8BDD\u3002\u5931\u8D25\u4F1A\u5728\u8FD4\u56DE\u91CC\u7528 [\u8B66\u544A] \u8BF4\u660E\u539F\u56E0\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "\u8981\u5F52\u6863\u7684\u6210\u5458\u4F1A\u8BDDid\uFF08call_member / wait_member \u8FD4\u56DE\uFF09\u3002" }
      },
      required: ["conversationId"],
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
      const conversationId = typeof args.conversationId === "string" ? args.conversationId.trim() : "";
      if (conversationId === "") throw new Error("conversationId is required");
      const result = await memberTasks.remove(conversationId);
      const task = result.task;
      const workspace = result.workspace !== "" ? result.workspace : memberTaskWorkspace(task);
      const directory = result.cwd !== "" ? result.cwd : "\uFF08\u6210\u5458\u672A\u62A5\u544A\u76EE\u5F55\uFF09";
      const memberRemoved = result.memberRemoved === true;
      const text = memberRemoved ? [
        `\u5DF2\u5220\u9664\u6210\u5458\u4F1A\u8BDD ${task.conversationId}\uFF08${task.member} ${task.memberIp}\uFF0C\u5DE5\u4F5C\u533A ${workspace}\uFF09\u3002`,
        `\u6210\u5458\u4FA7\u5DF2\u5F52\u6863\u3001\u5220\u9664\u5BF9\u8BDD\u8BB0\u5F55\u3001\u5220\u9664\u5DE5\u4F5C\u533A\u8BB0\u5F55\uFF08${result.recordRemoved ? "\u5DF2\u5220\u9664" : "\u6CA1\u6709\u5BF9\u5E94\u8BB0\u5F55"}\uFF09\u3002`,
        result.directoryRemoved ? `\u5DE5\u4F5C\u533A\u76EE\u5F55\u5DF2\u6E05\u7A7A\u5E76\u5220\u9664\uFF1A${directory}` : `\u5DE5\u4F5C\u533A\u76EE\u5F55\u6CA1\u6709\u5220\u9664\uFF08\u53EF\u80FD\u4E0D\u5728\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\u4E0B\uFF0C\u6216\u5220\u9664\u5931\u8D25\uFF09\uFF1A${directory}`,
        "\u672C\u673A\u7684\u4EFB\u52A1\u8BB0\u5F55\u548C\u65E5\u5FD7\u4E5F\u5DF2\u5220\u9664\uFF1B\u8FD9\u4E2A\u4F1A\u8BDDid \u4E0D\u80FD\u518D\u6295\u9012\uFF0C\u5DE5\u4F5C\u533A\u540D\u53EF\u4EE5\u91CD\u65B0\u4F7F\u7528\u3002"
      ].join("\n") : [
        `[\u8B66\u544A] \u5DF2\u79FB\u9664\u672C\u673A\u6210\u5458\u8BB0\u5F55 ${task.conversationId}\uFF08${task.member} ${task.memberIp}\uFF09\uFF1B\u6210\u5458\u4FA7\u5F52\u6863/\u5220\u9664\u5931\u8D25\u3002`,
        `\u6210\u5458\u4FA7\u5931\u8D25\u539F\u56E0\uFF1A${result.memberError ?? "\u672A\u77E5\u9519\u8BEF"}`,
        "\u672C\u673A\u4EFB\u52A1\u8BB0\u5F55\u548C\u65E5\u5FD7\u5DF2\u5220\u9664\uFF0C\u672C\u673A\u4E0D\u518D\u8DDF\u8E2A\u8FD9\u4E2A\u4F1A\u8BDD\uFF1B\u6210\u5458\u4E0A\u7684\u5BF9\u8BDD\u53EF\u80FD\u4ECD\u7136\u5B58\u5728\uFF0C\u9700\u8981\u65F6\u5230\u6210\u5458\u7684 Web UI \u5F52\u6863/\u5220\u9664\u3002"
      ].join("\n");
      return {
        ok: true,
        text,
        data: {
          conversationId: task.conversationId,
          member: task.member,
          memberIp: task.memberIp,
          workspace,
          cwd: result.cwd,
          removed: true,
          localRemoved: true,
          memberRemoved,
          memberError: result.memberError ?? null,
          archived: memberRemoved,
          workspaceRecordRemoved: result.recordRemoved,
          workspaceDirectoryRemoved: result.directoryRemoved
        }
      };
    }
  };
  const stopAllMemberDefinition = {
    name: "stop_all_member",
    description: [
      "\u5411\u672C\u5BF9\u8BDD\u6240\u6709\u8FDB\u884C\u4E2D\u7684\u6210\u5458\u5BF9\u8BDD\u53D1\u9001\u4E00\u6761\u56FA\u5B9A\u7684\u505C\u6B62\u8BF7\u6C42\uFF1A",
      `\u300C${STOP_ALL_MEMBER_PROMPT}\u300D`,
      "",
      "\u53EA\u5904\u7406\u672C\u5BF9\u8BDD\u8DDF\u8E2A\u7684 running / starting \u6210\u5458\u5BF9\u8BDD\uFF1B\u4E0D\u4E2D\u65AD\u3001\u4E0D\u53D6\u6D88\u5BF9\u8BDD\uFF0C\u4E5F\u4E0D\u7B49\u5F85\u5B83\u4EEC\u7ED3\u675F\u3002",
      "\u5BF9\u6BCF\u4E2A\u4F1A\u8BDD\u4F9D\u6B21\u6295\u9012\uFF1B\u67D0\u4E2A\u4F1A\u8BDD\u5931\u8D25\u4F1A\u7EE7\u7EED\u5904\u7406\u5176\u4F59\u7684\u3002",
      "\u8FD4\u56DE\u53D1\u9001\u6210\u529F/\u5931\u8D25\u6570\u91CF\uFF0C\u4EE5\u53CA\u6BCF\u4E2A\u4F1A\u8BDD\u7684\u6295\u9012\u65B9\u5F0F\uFF08steer \u63D2\u5165\u5F53\u524D\u8F6E\uFF0C\u6216\u6392\u961F\u5230\u4E0B\u4E00\u8F6E\uFF09\u3002"
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
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      const originSessionId = originSessionOf(exec?.agent);
      if (originSessionId === "") throw new Error("stop_all_member needs the current session");
      const running = await memberTasks.inFlightForOrigin(originSessionId);
      const targets = Array.isArray(running) ? running : [];
      if (targets.length === 0) {
        return {
          ok: true,
          text: "\u6CA1\u6709\u8FDB\u884C\u4E2D\u7684\u6210\u5458\u5BF9\u8BDD\uFF1B\u6CA1\u6709\u53D1\u9001\u4EFB\u4F55\u6D88\u606F\u3002",
          data: { total: 0, sent: 0, failed: 0, prompt: STOP_ALL_MEMBER_PROMPT, conversations: [] }
        };
      }
      const results = [];
      for (const task of targets) {
        const base = {
          conversationId: String(task?.conversationId ?? ""),
          member: String(task?.member ?? ""),
          memberIp: String(task?.memberIp ?? "")
        };
        try {
          const sent2 = await memberTasks.send({
            conversationId: base.conversationId,
            prompt: STOP_ALL_MEMBER_PROMPT,
            agent: exec.agent,
            signal: exec.signal
          });
          results.push({ ...base, ok: true, delivery: sent2?.lastDelivery ?? null });
        } catch (error) {
          results.push({
            ...base,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      const sent = results.filter((result) => result.ok).length;
      const failed = results.length - sent;
      return {
        ok: failed === 0,
        text: [
          `\u5DF2\u5411 ${String(sent)}/${String(results.length)} \u4E2A\u8FDB\u884C\u4E2D\u7684\u6210\u5458\u5BF9\u8BDD\u53D1\u9001\u505C\u6B62\u8BF7\u6C42\uFF1A`,
          ...results.map((result) => {
            const target = `${result.conversationId}\uFF08${result.member} ${result.memberIp}\uFF09`;
            if (!result.ok) return `- ${target}\uFF1A\u5931\u8D25\uFF1A${result.error}`;
            const delivery = result.delivery === "steer" ? "\u5DF2\u63D2\u5165\u5F53\u524D\u8F6E" : result.delivery === "followup" ? "\u5DF2\u6392\u961F\u5230\u4E0B\u4E00\u8F6E" : "\u5DF2\u6295\u9012";
            return `- ${target}\uFF1A${delivery}`;
          })
        ].join("\n"),
        data: { total: results.length, sent, failed, prompt: STOP_ALL_MEMBER_PROMPT, conversations: results }
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
      "package \u53EF\u4EE5\u662F ~/.dsh/packages \u91CC\u7684\u6587\u4EF6\u540D\uFF0C\u4E5F\u53EF\u4EE5\u662F\u7EDD\u5BF9\u8DEF\u5F84\uFF1B.7z \u4E0E\u65E7\u7684 .tar.gz/.tgz/.zip \u90FD\u652F\u6301\u3002"
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
  for (const tool of [buildDefinition, deployDefinition, callMemberDefinition, setMemberScopeDefinition, setProductStageDefinition, waitMemberDefinition, statusMemberDefinition, removeMemberDefinition, stopAllMemberDefinition, membersDefinition, repackDefinition]) {
    try {
      toolsCtx.tools.register(tool);
      ctx.logger?.info?.(`mesh: registered tool ${tool.name}`);
    } catch (error) {
      ctx.logger?.error?.(`mesh: cannot register tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
function memberTaskData(task, memberTasks) {
  const { id: taskId, ...fields } = task;
  return { ...fields, logFile: memberTasks.logPath(taskId) };
}
function formatTaskProfileLine(task) {
  const profile = memberTaskProfile(task);
  if (profile === null) return "";
  const parts = [];
  if (typeof profile.role === "string" && profile.role !== "") parts.push(`\u6807\u51C6\u8EAB\u4EFD\uFF1A${profile.role}`);
  if (profile.identity !== null) parts.push(`\u8EAB\u4EFD\uFF1A${profile.identity}`);
  if (profile.scope !== null) parts.push(`\u8D1F\u8D23\u8303\u56F4\uFF1A${profile.scope}`);
  return parts.join("\uFF1B");
}
function formatTaskProfileMissingHint(task) {
  if (memberTaskProfile(task) !== null) return "";
  return "\u8BE5\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u8EAB\u4EFD/\u5DE5\u4F5C\u8303\u56F4\uFF1A\u4E0B\u6B21 call_member \u5E26 identity \u548C scope \u53C2\u6570\uFF0C\u6216\u7528 set_member_scope \u8BBE\u7F6E\u3002";
}
var MAX_FANOUT_CONVERSATIONS = 20;
function formatTokens(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "?";
  if (amount < 1e3) return String(Math.round(amount));
  if (amount < 1e6) return `${formatOneDecimal(amount / 1e3)}k`;
  return `${formatOneDecimal(amount / 1e6)}M`;
}
function formatOneDecimal(value) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/u, "");
}
function formatContextLine(context) {
  if (context === null || typeof context !== "object") return "";
  const used = Number.isFinite(context.usedTokens) ? context.usedTokens : null;
  const max = Number.isFinite(context.maxTokens) ? context.maxTokens : null;
  const percent = Number.isFinite(context.percent) ? context.percent : null;
  if (used === null && max === null) return "";
  const percentText = percent === null ? "" : `\uFF08${formatOneDecimal(percent)}%\uFF09`;
  if (max === null) return `\u5BF9\u8BDD\u4E0A\u4E0B\u6587\uFF1A\u5DF2\u7528 ${formatTokens(used)} tokens${percentText}\uFF08\u6210\u5458\u672A\u62A5\u544A\u4E0A\u9650\uFF09`;
  if (used === null) return `\u5BF9\u8BDD\u4E0A\u4E0B\u6587\uFF1A\u4E0A\u9650 ${formatTokens(max)} tokens\uFF08\u6210\u5458\u672A\u62A5\u544A\u5DF2\u7528\uFF09`;
  return `\u5BF9\u8BDD\u4E0A\u4E0B\u6587\uFF1A${formatTokens(used)} / ${formatTokens(max)} tokens${percentText}`;
}
function terminalResultText(task, replyText) {
  const alreadyDelivered = memberTaskResultAlreadyDelivered(task);
  const consumedByWait = Number.isSafeInteger(task.replySeq) && task.replySeq > 0 && Number.isSafeInteger(task.deliveredSeq) && task.deliveredSeq >= task.replySeq;
  const text = replyText !== "" ? replyText : alreadyDelivered || consumedByWait ? "" : typeof task.lastText === "string" ? task.lastText : "";
  return { text, alreadyDelivered, alreadyReturned: !alreadyDelivered && consumedByWait };
}
function requestedConversationIds(args) {
  const ids = [];
  const push = (value) => {
    const id = String(value ?? "").trim();
    if (id === "" || ids.includes(id)) return;
    ids.push(id);
  };
  if (typeof args?.conversationId === "string") push(args.conversationId);
  if (Array.isArray(args?.conversationIds)) {
    for (const value of args.conversationIds) push(value);
  }
  if (ids.length > MAX_FANOUT_CONVERSATIONS) {
    throw new Error(`too many conversations in one call: ${String(ids.length)} > ${String(MAX_FANOUT_CONVERSATIONS)}`);
  }
  return ids;
}
function originSessionOf(agent) {
  const sessionId = agent?.session?.id;
  if (typeof sessionId === "string" && sessionId !== "") return sessionId;
  return typeof agent?.id === "string" ? agent.id : "";
}
function projectDirOf(agent) {
  const cwd = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd ?? agent?.session?.cwd;
  return typeof cwd === "string" ? cwd.trim() : "";
}
function conversationListBlock(tasks, currentConversationId, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const withProfile = options.withProfile === true;
  const scopes = options.scopes ?? {};
  const conversations = withProfile ? list.map((task) => {
    const entry = describeMemberTask(task, currentConversationId);
    const stored = scopes[String(task.conversationId ?? "")];
    const profile = stored !== void 0 ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task);
    return { ...entry, profile, role: profile?.role ?? null, identity: profile?.identity ?? null, scope: profile?.scope ?? null };
  }) : list.map((task) => describeMemberTask(task, currentConversationId));
  if (conversations.length === 0) {
    return { lines: ["\u672C\u5BF9\u8BDD\u8FD8\u6CA1\u6709\u8DDF\u8E2A\u4EFB\u4F55\u6210\u5458\u4F1A\u8BDD\u3002"], conversations };
  }
  const profileSuffix = withProfile ? (entry) => `\u8EAB\u4EFD\uFF1A${entry.identity ?? "\u672A\u8BBE\u7F6E"}\uFF1B\u5DE5\u4F5C\u8303\u56F4\uFF1A${entry.scope ?? "\u672A\u8BBE\u7F6E"}` : () => "";
  return {
    lines: [
      `\u672C\u5BF9\u8BDD\u8DDF\u8E2A\u7684\u6210\u5458\u4F1A\u8BDD\uFF08\u5171 ${String(conversations.length)} \u4E2A\uFF0C* \u4E3A\u5F53\u524D\u4F1A\u8BDD\uFF09\uFF1A`,
      ...conversations.map((entry) => {
        const turn = entry.turns !== null && entry.turns > 0 ? `\uFF0C\u7B2C ${String(entry.turns)} \u8F6E` : "";
        const profile = profileSuffix(entry);
        return `- ${entry.current ? "* " : ""}${entry.conversationId}\uFF08${entry.member} ${entry.memberIp}\uFF0C\u5DE5\u4F5C\u533A ${entry.workspace}\uFF0C${entry.statusLabel}${turn}\uFF09${profile === "" ? "" : ` ${profile}`}`;
      })
    ],
    conversations
  };
}
async function originConversationBlock(memberTasks, sessionId, currentConversationId, options = {}) {
  const tasks = await memberTasks.listForOrigin(sessionId).catch(() => []);
  return conversationListBlock(tasks, currentConversationId, options);
}
function workspaceBusyResult(error, args) {
  const detail = error?.detail !== null && typeof error.detail === "object" ? error.detail : {};
  const occupied = Array.isArray(detail.conversationIds) ? detail.conversationIds.map(String) : [];
  const first = typeof detail.conversationId === "string" && detail.conversationId !== "" ? detail.conversationId : occupied[0] ?? "";
  const member = typeof args?.member === "string" ? args.member : "";
  const workspace = typeof detail.workspace === "string" ? detail.workspace : typeof args?.workspace === "string" ? args.workspace : "";
  const message = String(error?.memberMessage ?? error?.message ?? "\u76EE\u6807\u5DE5\u4F5C\u533A\u5DF2\u6709\u5BF9\u8BDD");
  return {
    ok: false,
    text: [
      "\u76EE\u6807\u5DE5\u4F5C\u533A\u5DF2\u7ECF\u6709\u5BF9\u8BDD\uFF0C\u8FD9\u6B21\u6CA1\u6709\u521B\u5EFA\u65B0\u5BF9\u8BDD\uFF08\u4E00\u4E2A\u5DE5\u4F5C\u533A\u53EA\u5141\u8BB8\u4E00\u4E2A\u5BF9\u8BDD\uFF09\u3002",
      message,
      first === "" ? "" : `\u7EE7\u7EED\u90A3\u4E2A\u5BF9\u8BDD\uFF1Acall_member { ${member === "" ? "" : `"member": ${JSON.stringify(member)}, `}"conversationId": ${JSON.stringify(first)}, "prompt": "..." }\u3002`,
      workspace === "" ? '\u8981\u5E76\u884C\u5DE5\u4F5C\u5C31\u6362\u4E00\u4E2A\u5DE5\u4F5C\u533A\uFF1Acall_member { "workspace": "<\u65B0\u7684\u5DE5\u4F5C\u533A\u540D>", "prompt": "..." }\u3002' : `\u8981\u5E76\u884C\u5DE5\u4F5C\u5C31\u6362\u4E00\u4E2A\u5DE5\u4F5C\u533A\u540D\uFF08\u73B0\u5728\u662F\u300C${workspace}\u300D\uFF09\uFF1Acall_member { "workspace": "<\u65B0\u7684\u5DE5\u4F5C\u533A\u540D>", "prompt": "..." }\u3002`
    ].filter((line) => line !== "").join("\n"),
    data: {
      ok: false,
      code: typeof error?.code === "string" && error.code !== "" ? error.code : "workspace_occupied",
      workspaceOccupied: true,
      member,
      workspace: workspace === "" ? null : workspace,
      cwd: typeof detail.cwd === "string" ? detail.cwd : null,
      occupiedConversationIds: occupied,
      conversationId: first === "" ? null : first
    }
  };
}
function maintenanceResult(error, args) {
  const state = error?.maintenance !== null && typeof error.maintenance === "object" ? error.maintenance : {};
  const message = String(error?.message ?? "\u76EE\u6807\u6210\u5458\u6B63\u5728\u5347\u7EA7");
  return {
    ok: false,
    text: [
      message,
      "\u5347\u7EA7/\u90E8\u7F72\u4F1A\u91CD\u542F\u76EE\u6807\u6210\u5458\u7684 DSH\uFF1B\u7B49\u5B83\u7ED3\u675F\u540E\u518D\u6D3E\u53D1\u6216\u7EE7\u7EED\u6210\u5458\u5BF9\u8BDD\u3002",
      "\u73B0\u5728\u6CA1\u6709\u521B\u5EFA\u6216\u6295\u9012\u4EFB\u4F55\u5BF9\u8BDD\uFF1B\u5347\u7EA7\u7ED3\u675F\u540E\u7528\u540C\u4E00\u4E2A conversationId \u7EE7\u7EED\u5373\u53EF\uFF08\u65B0\u5EFA\u7684\u7B49\u5347\u7EA7\u5B8C\u518D\u53D1\u8D77\uFF09\u3002"
    ].join("\n"),
    data: {
      ok: false,
      code: "member_maintenance",
      member: typeof args?.member === "string" ? args.member : null,
      conversationId: typeof args?.conversationId === "string" ? args.conversationId : null,
      kind: typeof state.kind === "string" ? state.kind : null,
      phase: typeof state.phase === "string" ? state.phase : null,
      job: typeof state.job === "string" ? state.job : null,
      since: typeof state.since === "string" ? state.since : null
    }
  };
}
function formatRemainingWait(remaining) {
  if (!Array.isArray(remaining) || remaining.length === 0) return [];
  return [
    `\u8FD8\u6709 ${String(remaining.length)} \u4E2A\u4F1A\u8BDD\u6CA1\u6709\u8FD4\u56DE\uFF1A`,
    ...remaining.map((entry) => {
      const turn = Number.isSafeInteger(entry.turns) && entry.turns > 0 ? `\uFF0C\u7B2C ${String(entry.turns)} \u8F6E` : "";
      const workspace = typeof entry.workspace === "string" && entry.workspace !== "" ? `\uFF0C\u5DE5\u4F5C\u533A ${entry.workspace}` : "";
      return `- ${entry.conversationId}\uFF08${entry.member} ${entry.memberIp}${workspace}${turn}\uFF0C${remainingStatusLabel(entry)}\uFF09`;
    })
  ];
}
function remainingStatusLabel(entry) {
  if (entry?.settled !== true) return "\u8FDB\u884C\u4E2D";
  if (entry.status === "completed") return "\u5DF2\u5B8C\u6210\uFF0C\u7ED3\u679C\u8FD8\u6CA1\u53D6\u8D70";
  if (entry.status === "failed") return "\u5DF2\u5931\u8D25";
  if (entry.status === "interrupted") return "\u5F02\u5E38\u4E2D\u6B62";
  return String(entry.status);
}
function describeStatus(found, memberTasks, scopes = {}) {
  const { task, live, liveError } = found;
  const liveStatus = typeof live?.status === "string" ? live.status : "";
  const turns = Number.isSafeInteger(live?.turns) ? live.turns : Number.isSafeInteger(task.turns) ? task.turns : null;
  const liveWorkspace = typeof live?.workspace === "string" ? live.workspace.trim() : "";
  const stored = scopes[String(task.conversationId ?? "")];
  const profile = stored !== void 0 ? memberTaskProfile({ profile: stored }) : memberTaskProfile(task);
  const note = typeof stored?.note === "string" && stored.note.trim() !== "" ? stored.note.trim() : null;
  return {
    conversationId: task.conversationId,
    member: task.member,
    memberIp: task.memberIp,
    workspace: liveWorkspace !== "" ? liveWorkspace : memberTaskWorkspace(task),
    profile,
    role: profile?.role ?? null,
    identity: profile?.identity ?? null,
    scope: profile?.scope ?? null,
    note,
    status: liveStatus === "" ? task.status : liveStatus,
    liveStatus,
    statusLabel: memberStatusLabel(liveStatus, task),
    taskStatus: task.status,
    turns,
    context: live?.context ?? task.context ?? null,
    messages: memberTasks.sentMessages(task),
    reasoning: typeof live?.lastReasoning === "string" ? live.lastReasoning : "",
    error: task.error ?? null,
    liveError: liveError ?? null
  };
}
function statusData(entry) {
  return { ...entry };
}
function formatStatusBlock(entry) {
  const lines = [
    `\u6210\u5458\u4F1A\u8BDD ${entry.conversationId}\uFF08${entry.member} ${entry.memberIp}\uFF09`,
    entry.liveStatus === "" ? `\u72B6\u6001\uFF1A${entry.statusLabel}\uFF08\u76EE\u6807\u4E0D\u53EF\u8FBE\uFF1A${entry.liveError ?? "unknown"}\uFF09` : `\u72B6\u6001\uFF1A${entry.statusLabel}\uFF08\u76EE\u6807\u5B9E\u65F6\uFF09`,
    `\u672C\u673A\u4EFB\u52A1\uFF1A${entry.taskStatus}${entry.turns === null ? "" : `\uFF0C\u8F6E\u6B21 ${String(entry.turns)}`}`,
    `\u5DE5\u4F5C\u533A\uFF1A${entry.workspace ?? "unknown"}`,
    `\u6807\u51C6\u8EAB\u4EFD\uFF1A${entry.role ?? "\u672A\u8BBE\u7F6E"}\uFF1B\u8EAB\u4EFD\uFF1A${entry.identity ?? "\u672A\u8BBE\u7F6E"}\uFF1B\u5DE5\u4F5C\u8303\u56F4\uFF1A${entry.scope ?? "\u672A\u8BBE\u7F6E"}`,
    `\u5907\u6CE8\uFF1A${entry.note ?? "\u672A\u8BBE\u7F6E"}`,
    formatContextLine(entry.context),
    entry.messages.length === 0 ? "\u6700\u8FD1\u4E24\u6B21\u7528\u6237\u6D88\u606F\uFF1A(\u6CA1\u6709\u8BB0\u5F55)" : "\u6700\u8FD1\u4E24\u6B21\u7528\u6237\u6D88\u606F\uFF08\u65E7\u2192\u65B0\uFF09\uFF1A",
    ...entry.messages.map((message, index) => `${String(index + 1)}. ${typeof message.at === "string" && message.at !== "" ? `[${message.at}] ` : ""}${truncateText(message.text, 1200)}`),
    entry.reasoning === "" ? "\u6700\u8FD1\u4E00\u6B21\u601D\u8003\uFF1A(\u76EE\u6807\u6CA1\u6709\u62A5\u544A\u601D\u8003)" : `\u6700\u8FD1\u4E00\u6B21\u601D\u8003\uFF1A${truncateText(entry.reasoning, 4e3)}`,
    typeof entry.error === "string" && entry.error !== "" ? `\u9519\u8BEF\uFF1A${entry.error}` : ""
  ];
  return lines.filter((line) => line !== "").join("\n");
}
function memberStatusLabel(liveStatus, task) {
  if (liveStatus === "running") return "\u8FDB\u884C\u4E2D";
  if (liveStatus === "idle") return "\u7A7A\u95F2";
  if (liveStatus === "interrupted") return "\u5F02\u5E38\u4E2D\u6B62";
  if (liveStatus === "error") return "\u51FA\u9519";
  if (liveStatus === "blank") return "\u5C1A\u672A\u5F00\u59CB";
  if (liveStatus !== "") return liveStatus;
  if (task.status === "running" || task.status === "starting") return "\u8FDB\u884C\u4E2D\uFF08\u672C\u673A\uFF09";
  if (task.status === "interrupted") return "\u5F02\u5E38\u4E2D\u6B62\uFF08\u672C\u673A\uFF09";
  if (task.status === "failed") return "\u5931\u8D25\uFF08\u672C\u673A\uFF09";
  if (task.status === "completed") return "\u5DF2\u5B8C\u6210\uFF08\u672C\u673A\uFF09";
  return String(task.status);
}
function truncateText(text, limit) {
  const value = String(text ?? "");
  return value.length <= limit ? value : `${value.slice(0, limit)}\u2026`;
}
async function compressThresholdFor(service, conversationId) {
  if (typeof service?.memberScope !== "function") return DEFAULT_COMPRESS_PERCENT;
  const scope = await service.memberScope(conversationId).catch(() => null);
  return effectiveCompressPercent(scope);
}
function formatCompactionAdvice(context, threshold = DEFAULT_COMPRESS_PERCENT) {
  if (context === null || typeof context !== "object") return "";
  const percent = Number.isFinite(context.percent) ? context.percent : null;
  if (percent === null || percent <= threshold) return "";
  return `\u5BF9\u8BDD\u4E0A\u4E0B\u6587\u5DF2\u7528 ${formatOneDecimal(percent)}%\uFF0C\u8D85\u8FC7\u672C\u4F1A\u8BDD\u538B\u7F29\u9608\u503C ${formatOneDecimal(threshold)}%\uFF1A\u4E0B\u6B21 call_member \u6295\u9012\u524D\u4F1A\u81EA\u52A8\u538B\u7F29\u3002`;
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
import { execFile as execFile4 } from "node:child_process";
import { createHash as createHash9, randomBytes as randomBytes3, randomUUID as randomUUID4, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
import { existsSync as existsSync15, mkdirSync as mkdirSync2, readFileSync as readFileSync6, readdirSync as readdirSync2, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import http3 from "node:http";
import { homedir as homedir3, tmpdir as tmpdir5 } from "node:os";
import path31 from "node:path";
import { promisify as promisify4 } from "node:util";

// code/shared/conversation-meta.mjs
var TITLE_LIMIT = 80;
var INITIATOR_LIMIT = 64;
var PREVIEW_LIMIT = 400;
var PROMPT_LIMIT = 8e3;
var REASONING_LIMIT = 4e3;
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
    // Archived conversations are hidden from the Web list but stay readable
    // for a late `/result`; the flag must survive a restart with the rest.
    archived: conversation.archived === true,
    archivedAt: typeof conversation.archivedAt === "string" ? conversation.archivedAt : null,
    cwd: conversation.cwd,
    // Kept so the panel can show what was sent and which workspace it named,
    // even after a restart replaced the in-memory conversation.
    prompt: typeof conversation.prompt === "string" ? conversation.prompt : "",
    workspace: typeof conversation.workspace === "string" ? conversation.workspace : "",
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastText: clip(conversation.lastText, PREVIEW_LIMIT),
    lastReasoning: clip(conversation.lastReasoning, REASONING_LIMIT),
    // The failure a turn ended with must survive the restart that follows it;
    // otherwise the panel and the waiting member see a completed task with no
    // result.
    error: typeof conversation.error === "string" && conversation.error !== "" ? conversation.error : null,
    turns: Number.isSafeInteger(conversation.turns) ? conversation.turns : 0,
    // The reply cursor must survive a restart: callers remember the last reply
    // seq they received, and a counter that restarted at zero would make every
    // new reply look already seen.
    replySeq: Number.isSafeInteger(conversation.replySeq) ? conversation.replySeq : 0
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
    archived: record.archived === true,
    archivedAt: typeof record.archivedAt === "string" ? record.archivedAt : null,
    title: typeof record.title === "string" ? record.title : "",
    prompt: typeof record.prompt === "string" ? record.prompt.slice(0, PROMPT_LIMIT) : "",
    workspace: typeof record.workspace === "string" ? record.workspace : "",
    initiator: normalizeInitiator(record.initiator),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : (/* @__PURE__ */ new Date()).toISOString(),
    lastText: typeof record.lastText === "string" ? record.lastText : "",
    lastReasoning: typeof record.lastReasoning === "string" ? record.lastReasoning : "",
    error: abandoned ? INTERRUPTED_ERROR : typeof record.error === "string" && record.error !== "" ? record.error : null,
    turns: Number.isSafeInteger(record.turns) ? record.turns : 0,
    // Reply texts stay in memory, but the cursor is a durable contract with
    // callers: it never goes backwards across a restart.
    replySeq: Number.isSafeInteger(record.replySeq) ? record.replySeq : 0
  };
}

// code/shared/conversation-replies.mjs
var MAX_REPLIES = 50;
function assistantReasoning(event) {
  if (event?.type !== "assistant/message") return "";
  const blocks = event?.data?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((block) => block?.type === "reasoning" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
}
function assistantText(event) {
  if (event?.type !== "assistant/message") return "";
  const blocks = event?.data?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
}
function applySessionEvent(conversation, event) {
  const type = event?.type;
  if (type === "assistant/message") {
    const reasoning = assistantReasoning(event);
    if (reasoning !== "") conversation.lastReasoning = reasoning;
    const text2 = assistantText(event);
    if (text2 === "") return null;
    conversation.lastText = text2;
    conversation.turnText = typeof conversation.turnText === "string" ? `${conversation.turnText}${text2}` : text2;
    return null;
  }
  if (type === "turn/start") {
    conversation.turnText = "";
    conversation.lastReasoning = "";
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
var execFileAsync3 = promisify4(execFile4);
var QUESTION_TOOL = "ask_user_question";
var MEMBER_INTERACTION_RULE = [
  "\u672C\u4F1A\u8BDD\u7981\u7528\u4E86 ask_user_question\uFF1A\u6CA1\u6709\u53EF\u4EE5\u5E94\u7B54\u7684\u7528\u6237\uFF0C\u63D0\u95EE\u4E0D\u4F1A\u5F97\u5230\u56DE\u7B54\u3002",
  "\u9700\u8981\u989D\u5916\u4FE1\u606F\u6216\u51B3\u7B56\u65F6\uFF0C\u5728\u56DE\u590D\u91CC\u628A\u95EE\u9898\u5199\u6E05\u695A\u5E76\u7ED3\u675F\u8FD9\u4E00\u8F6E\uFF1B\u59D4\u6D3E\u65B9\u4F1A\u7528\u540C\u4E00\u4F1A\u8BDD\u7EE7\u7EED\u56DE\u7B54\u3002"
].join("\n");
var MEMBER_SUBAGENT_RULE = [
  "\u8C03\u7528\u5B50\u4EE3\u7406\u65F6\u63A7\u5236\u5B83\u7684\u4E0A\u4E0B\u6587\u5360\u6BD4\uFF1B\u5982\u679C\u67D0\u4E2A\u5B50\u4EE3\u7406\u7684\u4E0A\u4E0B\u6587\u5360\u6BD4\u8D85\u8FC7 35%\uFF0C\u5C3D\u91CF\u6539\u7528\u65B0\u7684\u5B50\u4EE3\u7406\uFF08\u628A\u5DF2\u6709\u7ED3\u8BBA\u4EA4\u63A5\u7ED9\u65B0\u5B50\u4EE3\u7406\uFF09\uFF0C\u4E0D\u8981\u7EE7\u7EED\u7528\u8FD9\u4E2A\u5B50\u4EE3\u7406\u3002"
].join("\n");
var INTERACTION_CONTEXT_ORDER = 125;
var SUBAGENT_CONTEXT_ORDER = 128;
var MAX_EVENTS = 5e3;
var DEFAULT_WORKSPACE2 = "default-workspace";
var EMBEDDED_INTEROP_MARKER = "dsh-mesh-embedded-interop-v1";
var MAX_BODY = 1024 * 1024;
var SCRATCH_MAX_CHARS = 8 * 1024 * 1024;
var SETTLE_MS = 300;
function readEnvFile2(file) {
  const values = {};
  if (!existsSync15(file)) return values;
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
  if (typeof explicit === "string" && explicit.trim() !== "") candidates.push(path31.resolve(explicit));
  const packageRoot = process.env.DSH_PACKAGE_ROOT;
  if (typeof packageRoot === "string" && packageRoot.trim() !== "") {
    candidates.push(path31.join(packageRoot, "config", "interop.env"));
  }
  const home = process.env.DSH_HOME;
  if (typeof home === "string" && home.trim() !== "") {
    candidates.push(path31.join(path31.dirname(home), "config", "interop.env"));
    candidates.push(path31.join(home, "config", "interop.env"));
  }
  let current = process.cwd();
  for (let depth = 0; depth < 7; depth += 1) {
    candidates.push(path31.join(current, "config", "interop.env"));
    const parent = path31.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}
function findInteropConfig() {
  for (const candidate of configCandidates()) {
    if (existsSync15(candidate)) return candidate;
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
  const root = file === null ? null : path31.dirname(path31.dirname(file));
  const values = file === null ? {} : readEnvFile2(file);
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
  const dataDir = root === null ? path31.join(process.env.DSH_HOME ?? path31.join(process.cwd(), ".dsh"), "mesh", "interop") : path31.join(root, "data");
  const tokenFile = path31.join(dataDir, "interop-token");
  let gatePassword = typeof process.env.DSH_GATE_PASSWORD === "string" ? process.env.DSH_GATE_PASSWORD : "";
  if (useGatePassword && gatePassword === "" && root !== null) {
    gatePassword = readEnvFile2(path31.join(root, "config", "gate.env")).DSH_GATE_PASSWORD ?? "";
  }
  let token = "";
  if (useGatePassword) {
    token = gatePassword;
  } else {
    token = setting("DSH_INTEROP_TOKEN", "");
    if (token === "" && typeof config.interopToken === "string") token = config.interopToken;
    if (token === "" && existsSync15(tokenFile)) {
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
    root === null ? process.cwd() : path31.join(root, "workspace")
  );
  return {
    file,
    root,
    dataDir,
    tokenFile,
    logFile: path31.join(dataDir, "interop-service.log"),
    stateFile: path31.join(dataDir, "conversations.json"),
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
    workdir: path31.resolve(workdir),
    // Task workspaces are always below this root, so a workspace name sent by
    // the panel can never address an arbitrary directory on the member.
    workspaceRoot: path31.resolve(setting("DSH_WORKSPACES_DIR", path31.join(homedir3(), ".dsh", "workspaces"))),
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
  return path31.join(workspaceRootOf(settings), name);
}
function sameDirectory(left, right) {
  if (typeof left !== "string" || left === "" || typeof right !== "string" || right === "") return false;
  try {
    return path31.resolve(left) === path31.resolve(right);
  } catch {
    return false;
  }
}
function workspaceRootOf(settings) {
  const root = settings.workspaceRoot;
  return typeof root === "string" && root.trim() !== "" ? path31.resolve(root) : path31.join(homedir3(), ".dsh", "workspaces");
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
      workspaces.push({ name: entry.name, path: path31.join(dir, entry.name) });
    }
  } catch {
  }
  workspaces.sort((left, right) => left.name.localeCompare(right.name));
  return { dir, workspaces };
}
function httpError(status, code, message, detail) {
  return Object.assign(new Error(message), { status, code, ...detail === void 0 ? {} : { detail } });
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
function fail(response, status, code, message, detail) {
  json(response, status, {
    ok: false,
    error: { code, message, ...detail === void 0 ? {} : { detail } }
  });
}
function writeScratch(body) {
  const text = typeof body.text === "string" ? body.text : "";
  if (text.trim() === "") throw httpError(400, "empty_text", "text is empty");
  if (text.length > SCRATCH_MAX_CHARS) {
    throw httpError(413, "text_too_large", `text is longer than ${String(SCRATCH_MAX_CHARS)} characters`);
  }
  const hint = typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : "message";
  const safe = hint.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 60) || "message";
  const dir = path31.join(tmpdir5(), "dsh-mesh-messages");
  mkdirSync2(dir, { recursive: true });
  const file = path31.join(dir, `${safe}-${Date.now().toString(36)}-${randomUUID4().slice(0, 8)}.md`);
  writeFileSync(file, text, "utf8");
  return { path: file, bytes: Buffer.byteLength(text, "utf8") };
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
function userMessage2(blocks) {
  return { id: randomUUID4(), role: "user", content: blocks, source: { kind: "user" } };
}
function nonNegativeOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function summaryText2(value) {
  if (!Array.isArray(value)) return "";
  return value.filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
}
function createInteropService(options) {
  const ctx = options.ctx;
  const config = options.config ?? {};
  const settings = options.settings ?? resolveInteropSettings(config);
  const logLine = options.log ?? (() => {
  });
  const retry = options.retry !== false;
  const upgradePlanFile = typeof options.upgradePlanFile === "string" && options.upgradePlanFile !== "" ? options.upgradePlanFile : path31.join(settings.dataDir, "upgrade-plan.json");
  const conversations = /* @__PURE__ */ new Map();
  const bySession = /* @__PURE__ */ new Map();
  const handles = /* @__PURE__ */ new Map();
  const preparedAgents = /* @__PURE__ */ new WeakSet();
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
  const tokenDigest = settings.token === "" ? null : createHash9("sha256").update(settings.token).digest();
  function authorized(request) {
    if (tokenDigest === null) return false;
    const header = request.headers.authorization ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : String(request.headers["x-dsh-interop-token"] ?? "");
    if (raw === "") return false;
    const digest = createHash9("sha256").update(raw).digest();
    return digest.length === tokenDigest.length && timingSafeEqual2(digest, tokenDigest);
  }
  function workspaceRegistry() {
    return typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : ctx.workspaceRegistry;
  }
  function sessionArchived(conversation) {
    try {
      const ids = workspaceRegistry()?.archivedSessionIds;
      if (Array.isArray(ids)) return ids.includes(conversation.sessionId);
    } catch {
    }
    return conversation.archived === true;
  }
  function publicConversation(conversation) {
    return {
      id: conversation.id,
      sessionId: conversation.sessionId,
      status: conversation.status,
      archived: sessionArchived(conversation),
      archivedAt: typeof conversation.archivedAt === "string" ? conversation.archivedAt : null,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastText: conversation.lastText,
      lastReasoning: typeof conversation.lastReasoning === "string" ? conversation.lastReasoning : "",
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
  function contextOf(conversation) {
    const session = conversation?.agent?.session;
    if (session === void 0 || session === null) return null;
    let pressure;
    const projections = typeof ctx.get === "function" ? ctx.get("sessionProjections") : void 0;
    if (typeof projections?.snapshot === "function") {
      try {
        pressure = projections.snapshot(session, ["contextPressure"]).values.contextPressure;
      } catch {
      }
    }
    if (pressure === void 0) {
      const meter = typeof ctx.get === "function" ? ctx.get("tokenMeter") : void 0;
      if (typeof meter?.contextPressure === "function") {
        try {
          pressure = meter.contextPressure(session);
        } catch {
        }
      }
    }
    if (pressure === null || typeof pressure !== "object") return null;
    const usedTokens = nonNegativeOrNull(pressure.projectedTokens) ?? nonNegativeOrNull(pressure.pressureTokens);
    const maxTokens = nonNegativeOrNull(pressure.contextWindow);
    if (usedTokens === null && maxTokens === null) return null;
    return {
      usedTokens,
      maxTokens,
      percent: usedTokens !== null && maxTokens !== null && maxTokens > 0 ? Math.round(usedTokens / maxTokens * 1e3) / 10 : null
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
    if (!existsSync15(settings.stateFile)) return;
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
        markMemberSession(conversation.sessionId);
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
    if (conversation.archived === true) return;
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
        // Resume re-runs setup on the restored session, so the denied question
        // tool and the interaction rules come back with it.
        setup: async (agentCtx, agent) => {
          if (composition.presets !== void 0 && composition.id !== "") {
            await composition.presets.mount(agentCtx, composition.id);
          }
          applyMemberSetup(agentCtx, agent);
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
  function applyMemberSetup(agentCtx, agent) {
    if (agentCtx === null || typeof agentCtx !== "object") return;
    if (agent !== void 0 && agent !== null) {
      if (preparedAgents.has(agent)) return;
      preparedAgents.add(agent);
    }
    const tools = agentCtx.tools;
    if (tools !== void 0 && tools !== null && typeof tools.restrict === "function") {
      try {
        tools.restrict({ deny: [QUESTION_TOOL] });
      } catch (error) {
        log(`could not disable ${QUESTION_TOOL}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const systemPrompt = agentCtx.systemPrompt;
    if (systemPrompt !== void 0 && systemPrompt !== null && typeof systemPrompt.context === "function") {
      try {
        systemPrompt.context({
          name: "mesh:interaction",
          order: INTERACTION_CONTEXT_ORDER,
          interpolate: false,
          text: MEMBER_INTERACTION_RULE
        });
        systemPrompt.context({
          name: "mesh:subagent",
          order: SUBAGENT_CONTEXT_ORDER,
          interpolate: false,
          text: MEMBER_SUBAGENT_RULE
        });
      } catch (error) {
        log(`could not inject the member interaction rules: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  async function attachWorkspaceSession(registry, cwd, title, sessionId) {
    if (registry === void 0 || registry === null) return;
    try {
      const existing = typeof registry.resolveByPath === "function" ? await registry.resolveByPath(cwd) : void 0;
      const workspace = existing !== void 0 && existing !== null ? existing : typeof registry.create === "function" ? await registry.create(cwd, title) : void 0;
      if (workspace !== void 0 && workspace !== null && typeof workspace.attachSession === "function") {
        await workspace.attachSession(sessionId);
      }
    } catch (error) {
      log(`could not attach ${sessionId} to workspace ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function defaultWorkspaceDirectory(registry, settings2) {
    if (registry !== void 0 && registry !== null && typeof registry.list === "function") {
      try {
        const listed = registry.list();
        const existing = Array.isArray(listed) ? listed.find((workspace) => {
          if (workspace?.title !== DEFAULT_WORKSPACE2) return false;
          if (typeof workspace.path !== "string" || workspace.path === "") return false;
          try {
            return statSync(workspace.path).isDirectory();
          } catch {
            return false;
          }
        }) : void 0;
        if (existing !== void 0) return existing.path;
      } catch {
      }
    }
    return workspacePath(settings2, DEFAULT_WORKSPACE2);
  }
  async function createConversation(request) {
    if (typeof ctx.agents?.create !== "function") {
      throw httpError(503, "sdk_unavailable", "DSH agent runtime is not available");
    }
    const id = randomUUID4();
    const registry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : ctx.workspaceRegistry;
    const requested = normalizeWorkspaceName(request.workspace);
    const explicitCwd = typeof request.cwd === "string" && request.cwd !== "" ? path31.resolve(request.cwd) : "";
    const workspace = requested !== "" ? requested : explicitCwd === "" ? DEFAULT_WORKSPACE2 : "";
    const cwd = requested !== "" ? requested === DEFAULT_WORKSPACE2 ? defaultWorkspaceDirectory(registry, settings) : workspacePath(settings, requested) : explicitCwd !== "" ? explicitCwd : defaultWorkspaceDirectory(registry, settings);
    const occupied = [...conversations.values()].filter((conversation2) => !sessionArchived(conversation2) && sameDirectory(conversation2.cwd, cwd));
    if (occupied.length > 0) {
      const busyName = workspace !== "" ? workspace : path31.basename(cwd) || cwd;
      const first = occupied[0];
      const label = occupied.map((conversation2) => `${conversation2.id}\uFF08${conversation2.status}\uFF09`).join("\u3001");
      throw httpError(
        409,
        "workspace_occupied",
        `\u76EE\u6807\u5DE5\u4F5C\u533A\u300C${busyName}\u300D\uFF08${cwd}\uFF09\u5DF2\u6709\u5BF9\u8BDD\uFF1A${label}\u3002\u4E00\u4E2A\u5DE5\u4F5C\u533A\u53EA\u5141\u8BB8\u4E00\u4E2A\u5BF9\u8BDD\uFF1A\u8BF7\u76F4\u63A5 call_member \u5E26 conversationId "${first.id}" \u7EE7\u7EED\u8FD9\u4E2A\u5BF9\u8BDD\uFF1B\u9700\u8981\u65B0\u7684\u5DE5\u4F5C\u533A\u5C31\u6362\u4E00\u4E2A workspace \u540D\u3002`,
        { workspace: busyName, cwd, conversationIds: occupied.map((conversation2) => conversation2.id), conversationId: first.id }
      );
    }
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
    markMemberSession(id);
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
          applyMemberSetup(agentCtx, agent);
        }
      });
      handles.set(id, handle2);
      conversation.handle = handle2;
      conversation.agent = handle2.agent;
      appendTitle(conversation);
      if (prompt !== void 0) {
        handle2.agent.followup(userMessage2(contentBlocks(prompt)));
        conversation.status = "running";
        conversation.idle = false;
      }
      await attachWorkspaceSession(registry, cwd, workspace !== "" ? workspace : path31.basename(cwd) || DEFAULT_WORKSPACE2, id);
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
      unmarkMemberSession(id);
      throw error;
    }
  }
  async function sendMessage(conversation, request) {
    if (sessionArchived(conversation)) {
      throw httpError(409, "conversation_archived", "the conversation is archived; unarchive it on the member before sending another message");
    }
    if (conversation.archived === true) {
      conversation.archived = false;
      conversation.archivedAt = null;
      scheduleSave();
    }
    const blocks = contentBlocks(request.content ?? request.message ?? request.prompt);
    const agent = await ensureAgent(conversation);
    applyMemberSetup(agent.ctx, agent);
    conversation.prompted = true;
    conversation.status = "running";
    conversation.idle = false;
    conversation.error = null;
    conversation.failed = false;
    conversation.interrupted = false;
    conversation.notifiedAt = null;
    if (request.callbackUrl !== void 0) conversation.callbackUrl = String(request.callbackUrl);
    const message = userMessage2(blocks);
    let steered = false;
    if (agent.status === "running" && typeof agent.steer === "function") {
      try {
        agent.steer(message);
        steered = true;
      } catch (error) {
        log(`steer refused for ${conversation.id}, falling back to followup: ${error instanceof Error ? error.message : String(error)}`);
        steered = false;
      }
    }
    if (!steered) agent.followup(message);
    conversation.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    broadcast(conversation, { type: "message.accepted", sessionId: conversation.sessionId, ok: true, steered });
    scheduleSave();
    return { accepted: true, steered, delivery: steered ? "steer" : "followup" };
  }
  async function compactConversation(conversation) {
    const agent = await ensureAgent(conversation);
    const presets = typeof ctx.get === "function" ? ctx.get("agentPresets") : void 0;
    const scoped = typeof presets?.serviceFor === "function" ? presets.serviceFor(agent, "compaction") : void 0;
    const compaction = scoped ?? (typeof ctx.get === "function" ? ctx.get("compaction") : void 0);
    if (compaction === void 0 || typeof compaction.compactNow !== "function") {
      throw httpError(501, "compaction_unavailable", "this member has no compaction service");
    }
    if (agent.status !== "idle") {
      throw httpError(409, "conversation_busy", "the conversation is running; wait until it is idle before compacting");
    }
    const timeoutMs = Number.isSafeInteger(settings.requestTimeoutMs) && settings.requestTimeoutMs > 0 ? settings.requestTimeoutMs : 18e4;
    try {
      return await compaction.compactNow(agent, AbortSignal.timeout(timeoutMs));
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (code === "busy") {
        throw httpError(409, "conversation_busy", "the conversation is not idle or another compaction is running");
      }
      if (code === "cancelled") {
        throw httpError(408, "compaction_cancelled", "compaction was cancelled");
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`compaction failed for ${conversation.id}: ${message}`);
      throw httpError(502, "compaction_failed", `compaction failed${code === "" ? "" : ` (${code})`}: ${message}`);
    }
  }
  async function archiveConversation(conversation) {
    if (sessionArchived(conversation)) {
      conversation.archived = true;
      return { already: true };
    }
    const registry = workspaceRegistry();
    if (registry === void 0 || registry === null || typeof registry.archiveSession !== "function") {
      throw httpError(
        501,
        "archive_unavailable",
        "this member has no workspace registry; archive needs the embedded interop service of a Web host"
      );
    }
    try {
      await registry.archiveSession(conversation.sessionId, { stopActivity: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`archive failed for ${conversation.id}: ${message}`);
      throw httpError(502, "archive_failed", `cannot archive this conversation: ${message}`);
    }
    const handle2 = handles.get(conversation.id);
    if (handle2 !== void 0) {
      handles.delete(conversation.id);
      conversation.agent = null;
      conversation.handle = null;
      await Promise.resolve(handle2.dispose()).catch(() => {
      });
    }
    conversation.archived = true;
    conversation.archivedAt = (/* @__PURE__ */ new Date()).toISOString();
    conversation.status = "archived";
    conversation.idle = true;
    conversation.updatedAt = conversation.archivedAt;
    for (const waiter of [...conversation.waiters ?? []]) {
      try {
        waiter();
      } catch {
      }
    }
    saveState();
    broadcast(conversation, { type: "conversation.archived", sessionId: conversation.sessionId });
    log(`archived ${conversation.sessionId} (${conversation.id})`);
    return { already: false };
  }
  async function forgetConversation(conversation) {
    const handle2 = handles.get(conversation.id);
    if (handle2 !== void 0) {
      handles.delete(conversation.id);
      conversation.agent = null;
      conversation.handle = null;
      await Promise.resolve(handle2.dispose()).catch(() => {
      });
    }
    unmarkMemberSession(conversation.sessionId);
    conversations.delete(conversation.id);
    bySession.delete(conversation.sessionId);
    scheduleSave();
  }
  async function removeWorkspaceFor(cwd) {
    const directory = path31.resolve(cwd);
    const registry = workspaceRegistry();
    let recordRemoved = false;
    if (registry !== void 0 && registry !== null && typeof registry.list === "function" && typeof registry.delete === "function") {
      try {
        const listed = registry.list();
        const record = Array.isArray(listed) ? listed.find((workspace) => typeof workspace?.path === "string" && sameDirectory(workspace.path, directory)) : void 0;
        if (record !== void 0) {
          await registry.delete(record.id);
          recordRemoved = true;
        }
      } catch (error) {
        log(`could not delete the workspace record for ${directory}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let directoryRemoved = false;
    const root = path31.resolve(workspaceRootOf(settings));
    const relative = path31.relative(root, directory);
    const inside = relative !== "" && !relative.startsWith("..") && !path31.isAbsolute(relative);
    if (inside) {
      try {
        rmSync(directory, { recursive: true, force: true });
        directoryRemoved = true;
      } catch (error) {
        log(`could not remove the workspace directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      log(`kept ${directory}: it is outside the workspace root ${root}`);
    }
    return { recordRemoved, directoryRemoved, path: directory };
  }
  async function removeConversation(conversation) {
    const workspace = conversation.workspace ?? "";
    const cwd = conversation.cwd;
    const archive = await archiveConversation(conversation);
    await forgetConversation(conversation);
    const cleaned = await removeWorkspaceFor(cwd);
    log(`removed ${conversation.id}: workspace ${workspace === "" ? cwd : workspace} record=${String(cleaned.recordRemoved)} directory=${String(cleaned.directoryRemoved)}`);
    return { archived: true, alreadyArchived: archive.already, workspace, cwd: cleaned.path, ...cleaned };
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
    if (sessionArchived(conversation)) {
      return { timedOut: false, state: "archived", settled: true, text: conversation.lastText ?? "", turn: turnsOf(conversation), seq: seqOf(conversation), replies: [], archived: true };
    }
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
      unmarkMemberSession(conversation.sessionId);
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
      if (request.method === "POST" && url.pathname === "/v1/upgrade/prepare") {
        const result = await announceUpgrade(ctx, { planFile: upgradePlanFile, log });
        json(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/upgrade/plan") {
        json(response, 200, { ok: true, plan: await readUpgradePlan(upgradePlanFile) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/scratch") {
        const body = await readJson3(request);
        json(response, 200, { ok: true, ...writeScratch(body) });
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
      const match = /^\/v1\/conversations\/([^/]+)(?:\/(messages|notify|wait|events|result|compact|archive|remove))?$/u.exec(url.pathname);
      if (match === null) {
        fail(response, 404, "not_found", "Unknown endpoint.");
        return;
      }
      const conversation = findConversation(decodeURIComponent(match[1]));
      const suffix = match[2] ?? "";
      if (request.method === "GET" && suffix === "") {
        reconcileStatus(conversation);
        if (url.searchParams.get("resume") === "1") await ensureAgent(conversation);
        json(response, 200, {
          ok: true,
          conversation: publicConversation(conversation),
          context: contextOf(conversation)
        });
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
        json(response, 202, {
          ok: true,
          conversation: publicConversation(conversation),
          context: contextOf(conversation),
          receipt
        });
        return;
      }
      if (request.method === "POST" && suffix === "remove") {
        const result = await removeConversation(conversation);
        json(response, 200, { ok: true, removed: true, ...result });
        return;
      }
      if (request.method === "POST" && suffix === "archive") {
        const result = await archiveConversation(conversation);
        json(response, 200, { ok: true, archived: true, already: result.already, conversation: publicConversation(conversation) });
        return;
      }
      if (request.method === "POST" && suffix === "compact") {
        const result = await compactConversation(conversation);
        json(response, 200, {
          ok: true,
          compacted: result !== null,
          ...result === null ? {} : {
            summary: summaryText2(result.summary),
            shadowedCount: Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0,
            shadowedTokenCount: Number.isSafeInteger(result.shadowedTokenCount) ? result.shadowedTokenCount : null,
            startSeq: result.startSeq,
            summarySeq: result.summarySeq,
            endSeq: result.endSeq
          },
          context: contextOf(conversation)
        });
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
          archived: result.archived === true,
          settled: result.settled === true,
          text: typeof result.text === "string" ? result.text : "",
          turn: Number.isSafeInteger(result.turn) ? result.turn : turnsOf(conversation),
          seq: Number.isSafeInteger(result.seq) ? result.seq : seqOf(conversation),
          replies: Array.isArray(result.replies) ? result.replies : [],
          conversation: publicConversation(conversation),
          context: contextOf(conversation)
        });
        return;
      }
      fail(response, 405, "method_not_allowed", "Unsupported method for this endpoint.");
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = typeof error?.code === "string" ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) log(`request failed: ${message}`);
      fail(response, status, code, message, error?.detail);
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
      if (conversation.prompted && conversation.archived !== true) {
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
    clearMemberSessions();
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
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path32.join(homedir4(), ".dsh");
  return path32.join(home, "mesh");
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
    // ids to apply the default 06:00 entry (off until enabled) to members
    // without an override.
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
  const upgradePlanFile = path32.join(dataDirectory(), "upgrade-plan.json");
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
        void armUpgradeResume(agentsCtx, {
          planFile: upgradePlanFile,
          log: (line) => console.log(`mesh upgrade: ${line}`)
        }).catch((error) => {
          console.error(`mesh upgrade: could not arm the resume: ${error instanceof Error ? error.message : String(error)}`);
        });
        const interop = createInteropService({
          ctx: agentsCtx,
          settings,
          config,
          // Both ends of the announcement use the same file: the endpoint
          // writes it, the resume timer above consumes it after the restart.
          upgradePlanFile,
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
