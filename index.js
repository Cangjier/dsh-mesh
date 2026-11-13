// src/index.ts
import { homedir as homedir2 } from "node:os";
import path9 from "node:path";

// src/lib/service.mjs
import { mkdir as mkdir5, readFile as readFile7, readdir as readdir5, rm as rm5, stat as stat5, writeFile as writeFile5 } from "node:fs/promises";
import { readFileSync as readFileSync3, existsSync as existsSync7 } from "node:fs";
import { createHash as createHash5 } from "node:crypto";
import os5 from "node:os";
import path7 from "node:path";
import { fileURLToPath } from "node:url";

// code/shared/wireguard.mjs
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
var DEFAULT_MEMBER_PORTS = Object.freeze([80, 8080]);
var MEMBER_SERVICE = "dsh-mesh";
function dshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim();
  return configured && configured.length > 0 ? configured : path.join(os.homedir(), ".dsh");
}
async function readWireGuardState(options = {}) {
  const file = options.file ?? path.join(options.home ?? dshHome(), "wireguard", "state.json");
  try {
    const text = await readFile(file, "utf8");
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
  return isIP(text) > 0 ? text : "";
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
  return {
    name: typeof peer.name === "string" && peer.name.trim() !== "" ? peer.name.trim() : `peer-${ip}`,
    ip,
    online: peer.online !== false,
    lastHandshakeAt: typeof peer.lastHandshakeAt === "string" ? peer.lastHandshakeAt : null
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
  return isIP(address) === 6 ? `[${address}]` : address;
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
    dsh: probe.ok,
    port: probe.port,
    latencyMs: probe.latencyMs,
    gate: probe.info,
    system: probe.info?.system ?? null,
    error: probe.error
  }));
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

// code/build/job.mjs
import { appendFile, mkdir as mkdir2, readFile as readFile4, rename as rename2, rm as rm2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
import { randomBytes } from "node:crypto";
import os3 from "node:os";
import path4 from "node:path";

// code/build/engine.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync as existsSync2 } from "node:fs";
import { chmod, cp, mkdir, open, readFile as readFile3, readdir as readdir2, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import os2 from "node:os";
import path3 from "node:path";

// code/build/static-assets.mjs
import { existsSync } from "node:fs";
import { readFile as readFile2, readdir } from "node:fs/promises";
import path2 from "node:path";
var NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
var FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
var SHA256_PATTERN = /^[0-9a-f]{64}$/u;
async function collectStaticAssets(gateDirectory) {
  const assetsDirectory = path2.join(gateDirectory, "assets");
  if (!existsSync(assetsDirectory)) return [];
  const directories = await readdir(assetsDirectory, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    try {
      const manifestPath = path2.join(assetsDirectory, directory.name, "manifest.json");
      const raw = JSON.parse(await readFile2(manifestPath, "utf8"));
      const entries = Array.isArray(raw.assets) ? raw.assets : typeof raw.file === "string" ? [{ os: "windows", arch: "x64", file: raw.file, sha256: raw.sha256, bytes: raw.bytes }] : [];
      const assets = [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const file = typeof entry.file === "string" ? entry.file : "";
        const sha256 = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : "";
        const bytes = Number(entry.bytes);
        if (!FILE_PATTERN.test(file) || !SHA256_PATTERN.test(sha256)) continue;
        if (!Number.isSafeInteger(bytes) || bytes <= 0) continue;
        if (!existsSync(path2.join(assetsDirectory, directory.name, file))) continue;
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

// code/build/engine.mjs
var DEFAULT_SOURCE = "https://github.com/deepseek-ai/deepseek-harness";
var DEFAULT_REF = "master";
var DEFAULT_TARGETS = Object.freeze(["linux-x64", "win-x64"]);
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
  const [os6, arch] = String(target).split("-");
  if (!["linux", "win", "darwin"].includes(os6)) throw new Error(`unsupported target OS: ${target}`);
  if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported target architecture: ${target}`);
  return { os: os6, arch, libc: os6 === "linux" ? "glibc" : "" };
}
function classifySource(source) {
  const value = String(source).trim().replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");
  if (existsSync2(value)) return { kind: "local", dir: path3.resolve(value) };
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
async function download(url, file, options = {}) {
  if (existsSync2(file) && (await stat(file)).size > 0) return true;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {
  });
  log(`GET ${url}`);
  const response = await fetchImpl(url, { redirect: "follow" });
  if (response.status === 404) return false;
  if (!response.ok || response.body === null) throw new Error(`download failed: ${url} -> HTTP ${String(response.status)}`);
  await mkdir(path3.dirname(file), { recursive: true });
  const temporary = `${file}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
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
  await mkdir(destination, { recursive: true });
  if (archive.toLowerCase().endsWith(".zip") && process.platform !== "win32") {
    const temporary = `${destination}.zip-tmp`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true });
    const unzipped = await runCommand("unzip", ["-q", archive, "-d", temporary], { log: options.log });
    if (!unzipped.ok) {
      throw new Error(`cannot extract ${archive}: ${unzipped.error?.message ?? `unzip exited with ${String(unzipped.code)}`}
${unzipped.tail.join("\n")}`);
    }
    const entries = await readdir2(temporary);
    const first = entries[0];
    const wrapped = entries.length === 1 && first !== void 0 && (await stat(path3.join(temporary, first))).isDirectory();
    const content = wrapped ? path3.join(temporary, first) : temporary;
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
  const cacheDir = options.cacheDir ?? path3.join(os2.homedir(), ".dsh", "mesh", "cache");
  const urls = tarballUrls(classified, ref);
  const archive = path3.join(cacheDir, "sources", `${sha256Text(`${classified.owner}/${classified.repo}@${ref}`).slice(0, 16)}.tar.gz`);
  const immutable = /^[0-9a-f]{40}$/iu.test(ref);
  if (!immutable && existsSync2(archive)) {
    const age = Date.now() - (await stat(archive)).mtimeMs;
    if (age > (options.maxCacheAgeMs ?? 6 * 60 * 6e4)) {
      log(`refreshing cached tarball for ${ref} (older than the cache window)`);
      await rm(archive, { force: true });
    }
  }
  let downloaded = false;
  for (const url of urls) {
    downloaded = await download(url, archive, { fetchImpl: options.fetchImpl, log });
    if (downloaded) break;
  }
  if (!downloaded) throw new Error(`cannot find ref "${ref}" in ${classified.owner}/${classified.repo}`);
  const archiveSha256 = await sha256File(archive);
  const dir = path3.join(options.workDir, "src");
  log(`extracting ${path3.basename(archive)} to ${dir}`);
  await extractTarball(archive, dir, { log });
  return { dir, source, ref, local: false, archive, archiveSha256 };
}
async function loadRecipes(file) {
  const parsed = JSON.parse(await readFile3(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.steps)) {
    throw new Error(`${file} is not a recipe manifest`);
  }
  return parsed;
}
async function applyRecipes(options) {
  const log = options.log ?? (() => {
  });
  const applied = [];
  const skipped = [];
  const mismatches = [];
  for (const step of options.recipes.steps) {
    for (const entry of step.files ?? []) {
      const target = path3.join(options.dir, entry.path);
      const overlay = path3.join(options.overlayRoot, entry.overlay);
      const label = { step: step.id, title: step.title, doc: step.doc, path: entry.path };
      if (!existsSync2(overlay)) {
        mismatches.push({ ...label, reason: "overlay file is missing", expected: entry.baseSha256 ?? null, actual: null });
        continue;
      }
      let current = null;
      try {
        current = await readFile3(target, "utf8");
      } catch (error) {
        if (entry.baseSha256 !== null) {
          mismatches.push({ ...label, reason: "upstream file is missing", expected: entry.baseSha256, actual: null });
          continue;
        }
      }
      if (current !== null && current.includes(entry.marker)) {
        skipped.push(label);
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
      await mkdir(path3.dirname(target), { recursive: true });
      await cp(overlay, target);
      const written = await readFile3(target, "utf8");
      if (!written.includes(entry.marker)) {
        mismatches.push({ ...label, reason: "overlay was written but its marker is missing", expected: entry.baseSha256 ?? null, actual: sha256Text(written) });
        continue;
      }
      applied.push(label);
      log(`applied ${step.id}: ${entry.path}`);
    }
  }
  return { ok: mismatches.length === 0, applied, skipped, mismatches };
}
async function writeWorkOrder(options) {
  await mkdir(options.dir, { recursive: true });
  const jobDir = options.jobDir ?? options.dir;
  const jsonPath = path3.join(options.dir, "work-order.json");
  const markdownPath = path3.join(options.dir, "work-order.md");
  const promptPath = path3.join(options.dir, "subagent-prompt.txt");
  const prompt = [
    `\u4F60\u5728\u4E3A dsh-mesh \u6784\u5EFA ${options.source}@${options.ref} \u7684\u4FEE\u6539\u7248 Web \u5305\u3002`,
    "\u786E\u5B9A\u6027\u6784\u5EFA\u5728\u5E94\u7528\u6E90\u7801\u8986\u76D6\u5C42\u65F6\u5931\u8D25\u3002\u8BF7\u53EA\u4FEE\u590D\u5DE5\u4F5C\u6811\u91CC\u7684\u6E90\u7801\uFF0C\u4E0D\u8981\u653E\u5BBD\u8986\u76D6\u5C42\u6821\u9A8C\u3002",
    "\u5148\u8BFB work-order.md \u4E0E\u5BF9\u5E94\u7684 Step \u6587\u6863\uFF0C\u518D\u4FEE\u6539\u4E0B\u5217\u6587\u4EF6\uFF0C\u4F7F\u6BCF\u4E2A\u6587\u4EF6\u7684\u8986\u76D6\u5C42 marker \u5B58\u5728\uFF0C\u5E76\u8BA9 pnpm run build:web \u901A\u8FC7\u3002",
    `\u4FEE\u5B8C\u540E\u8C03\u7528 dsh-mesh \u7684 build \u5DE5\u5177\uFF0C\u5E76\u4F20 jobId="${path3.basename(jobDir)}"\uFF1B\u5B83\u4F1A\u81EA\u52A8\u628A\u4FEE\u6539\u56FA\u5316\u6210\u8986\u76D6\u5C42\u5E76\u7EE7\u7EED\u540C\u4E00\u4E2A job\u3002`,
    "",
    ...options.result.mismatches.map((item) => `- ${item.path}\uFF08${item.step}\uFF1B${item.doc}\uFF09\uFF1A${item.reason}`)
  ].join("\n");
  const markdown = [
    `# \u6784\u5EFA\u5DE5\u4F5C\u5355\uFF1A${options.source}@${options.ref}`,
    "",
    `- \u6E90\u7801\u6811\uFF1A\`${options.worktree ?? path3.join(jobDir, "src")}\``,
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
    `3. \u8C03\u7528 build \u5DE5\u5177\uFF0C\u53C2\u6570 \`jobId="${path3.basename(jobDir)}"\`\uFF1B\u5B83\u4F1A\u628A\u6539\u597D\u7684\u6587\u4EF6\u5199\u56DE \`build/overlays/\`\u3002`,
    "4. \u540C\u4E00\u6B21 build \u8C03\u7528\u4F1A\u590D\u7528\u5DE5\u4F5C\u6811\u7EE7\u7EED install/build/package\uFF1B\u4E0B\u4E00\u6B21\u540C\u4E00 ref \u4F1A\u76F4\u63A5\u5E94\u7528\u65B0\u8986\u76D6\u5C42\u3002",
    "",
    "## \u5EFA\u8BAE\u7684\u5B50\u4EE3\u7406\u63D0\u793A\u8BCD",
    "",
    "```text",
    prompt,
    "```"
  ].join("\n");
  await writeFile(jsonPath, JSON.stringify({
    source: options.source,
    ref: options.ref,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    jobDir,
    worktree: options.worktree ?? path3.join(jobDir, "src"),
    mismatches: options.result.mismatches
  }, null, 2), "utf8");
  await writeFile(markdownPath, markdown, "utf8");
  await writeFile(promptPath, prompt, "utf8");
  return { json: jsonPath, markdown: markdownPath, prompt: promptPath };
}
async function learnOverlays(options) {
  const learned = [];
  const actualByPath = new Map(
    (options.mismatches ?? []).filter((item) => typeof item.actual === "string" && /^[0-9a-f]{64}$/u.test(item.actual)).map((item) => [item.path, item.actual])
  );
  for (const step of options.recipes.steps) {
    for (const entry of step.files ?? []) {
      const source = path3.join(options.worktree, entry.path);
      let text;
      try {
        text = await readFile3(source, "utf8");
      } catch {
        throw new Error(`cannot learn ${entry.path}: the file is missing from the worktree`);
      }
      if (!text.includes(entry.marker)) {
        throw new Error(`cannot learn ${entry.path}: the overlay marker "${entry.marker}" is missing`);
      }
      const target = path3.join(options.overlayRoot, entry.overlay);
      await mkdir(path3.dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
      const actual = actualByPath.get(entry.path);
      if (actual !== void 0 && entry.baseSha256 !== null) entry.baseSha256 = actual;
      learned.push({ step: step.id, path: entry.path, overlay: entry.overlay });
    }
  }
  return { ok: true, learned, recipes: options.recipes };
}
async function runWebBuild(options) {
  const log = options.log ?? (() => {
  });
  const needsShell = (command) => process.platform === "win32" && /^(pnpm|npm|npx|yarn|corepack)(\.cmd)?$/iu.test(command);
  const install = options.install === void 0 ? ["pnpm", "install", "--frozen-lockfile"] : options.install;
  const build = options.build ?? ["pnpm", "run", "build:web"];
  if (install !== null && install.length > 0) {
    log(`$ ${install.join(" ")}`);
    const installed = await runCommand(install[0], install.slice(1), {
      cwd: options.dir,
      log,
      shell: needsShell(install[0]),
      timeoutMs: 30 * 6e4
    });
    if (!installed.ok) {
      return { ok: false, dist: null, error: `dependency installation failed (exit ${String(installed.code)})
${installed.tail.join("\n")}` };
    }
  }
  log(`$ ${build.join(" ")}`);
  const built = await runCommand(build[0], build.slice(1), {
    cwd: options.dir,
    log,
    shell: needsShell(build[0]),
    timeoutMs: 30 * 6e4
  });
  if (!built.ok) {
    return { ok: false, dist: null, error: `web build failed (exit ${String(built.code)})
${built.tail.join("\n")}` };
  }
  const candidates = [
    path3.join(options.dir, "apps", "web", "dist"),
    path3.join(options.dir, "dist")
  ];
  for (const candidate of candidates) {
    if (existsSync2(path3.join(candidate, "index.html"))) return { ok: true, dist: candidate };
  }
  return { ok: false, dist: null, error: "the build finished but no dist/index.html was found" };
}
async function copyIfExists(from, to) {
  if (!existsSync2(from)) return;
  await mkdir(path3.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}
async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir2(current, { withFileTypes: true })) {
      const full = path3.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path3.relative(dir, full));
    }
  }
  if (existsSync2(dir)) await walk(dir);
  return out;
}
async function assembleWebPackage(options) {
  const { os: targetOs, arch, libc } = parseTarget(options.target);
  const packageDir = path3.join(options.outputDir, `dsh-mesh-${options.version}-${targetOs}-${arch}`);
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(path3.join(packageDir, "web"), { recursive: true });
  await cp(options.dist, path3.join(packageDir, "web"), { recursive: true });
  await copyIfExists(path3.join(options.repositoryRoot, "code", "gate"), path3.join(packageDir, "gate"));
  await copyIfExists(path3.join(options.repositoryRoot, "code", "shared"), path3.join(packageDir, "shared"));
  await copyIfExists(path3.join(options.repositoryRoot, "code", "config"), path3.join(packageDir, "config"));
  await copyIfExists(path3.join(options.repositoryRoot, "code", "windows-service"), path3.join(packageDir, "code", "windows-service"));
  await copyIfExists(path3.join(options.repositoryRoot, "code", "interop-service"), path3.join(packageDir, "code", "interop-service"));
  await copyIfExists(path3.join(options.repositoryRoot, "code", "wireguard"), path3.join(packageDir, "code", "wireguard"));
  await copyIfExists(path3.join(options.repositoryRoot, "docs"), path3.join(packageDir, "docs"));
  for (const file of ["install.sh", "start.sh", "stop.sh", "status.sh", "doctor.sh", "install.ps1", "start.ps1", "stop.ps1", "start.cmd", "stop.cmd", "start-stack.ps1", "VERSION"]) {
    await copyIfExists(path3.join(options.repositoryRoot, "code", file), path3.join(packageDir, file));
  }
  for (const file of ["start-interop.sh", "install-interop-service.sh", "uninstall-interop-service.sh"]) {
    await copyIfExists(path3.join(options.repositoryRoot, file), path3.join(packageDir, file));
  }
  for (const file of ["index.js", "client.js", "cordis.patch.yml", "package.json"]) {
    await copyIfExists(path3.join(options.repositoryRoot, file), path3.join(packageDir, "plugins", "dsh-mesh", file));
  }
  await copyIfExists(path3.join(options.repositoryRoot, "locale"), path3.join(packageDir, "plugins", "dsh-mesh", "locale"));
  await copyIfExists(path3.join(options.repositoryRoot, "build"), path3.join(packageDir, "plugins", "dsh-mesh", "build"));
  await copyIfExists(path3.join(options.repositoryRoot, "code", "build"), path3.join(packageDir, "plugins", "dsh-mesh", "code", "build"));
  await copyIfExists(path3.join(options.repositoryRoot, "code", "shared"), path3.join(packageDir, "plugins", "dsh-mesh", "code", "shared"));
  const staticAssets = await collectStaticAssets(path3.join(options.repositoryRoot, "code", "gate"));
  const manifest = {
    format: 1,
    name: "dsh-mesh",
    version: options.version,
    target: { os: targetOs, arch, libc },
    builtAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: options.source ?? null,
    ref: options.ref ?? null,
    tree: options.tree ?? null,
    files: (await listFiles(packageDir)).length,
    staticAssets
  };
  await writeFile(path3.join(packageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { packageDir, manifest };
}
async function fixTarExecutableModes(archive) {
  const raw = gunzipSync(await readFile3(archive));
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
  await writeFile(archive, gzipSync(raw, { level: 9 }));
}
async function archivePackage(packageDir, target, options = {}) {
  const { os: targetOs } = parseTarget(target);
  const archive = targetOs === "win" ? `${packageDir}.zip` : `${packageDir}.tar.gz`;
  await rm(archive, { force: true });
  let result;
  if (targetOs === "win" && process.platform !== "win32") {
    result = await runCommand("zip", ["-qr", archive, path3.basename(packageDir)], {
      cwd: path3.dirname(packageDir),
      log: options.log
    });
  } else {
    const args = targetOs === "win" ? ["-a", "-c", "-f", archive, "-C", path3.dirname(packageDir), path3.basename(packageDir)] : ["-czf", archive, "-C", path3.dirname(packageDir), path3.basename(packageDir)];
    result = await runCommand("tar", args, { log: options.log });
  }
  if (!result.ok) throw new Error(`cannot archive ${packageDir}: ${result.tail.join("\n")}`);
  if (targetOs !== "win" && process.platform === "win32") await fixTarExecutableModes(archive);
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
  const archive = path3.join(options.cacheDir, "node", archiveName);
  const downloaded = await download(`${base}/${archiveName}`, archive, { fetchImpl: options.fetchImpl, log });
  if (!downloaded) throw new Error(`Node ${options.version} has no ${parsed.os}-${parsed.arch} archive`);
  const sums = await fetch(`${base}/SHASUMS256.txt`, { redirect: "follow" });
  if (!sums.ok) throw new Error(`cannot read Node SHASUMS256.txt: HTTP ${String(sums.status)}`);
  const text = await sums.text();
  const line = text.split(/\r?\n/u).find((entry) => entry.endsWith(` ${archiveName}`));
  if (line === void 0) throw new Error(`Node SHASUMS256.txt has no entry for ${archiveName}`);
  const expected = line.split(/\s+/u)[0];
  const actual = await sha256File(archive);
  if (actual !== expected) throw new Error(`Node archive checksum mismatch for ${archiveName}`);
  await extractTarball(archive, options.destination, { log });
  if (parsed.os === "win") {
    if (!existsSync2(path3.join(options.destination, "node.exe"))) throw new Error("Node archive did not contain node.exe");
  } else {
    const node = path3.join(options.destination, "bin", "node");
    if (!existsSync2(node)) throw new Error("Node archive did not contain bin/node");
    await chmod(node, 493);
  }
  return { directory: options.destination, archive, sha256: actual };
}
async function installAppDependencies(options) {
  const parsed = parseTarget(options.target);
  const log = options.log ?? (() => {
  });
  await mkdir(options.appDir, { recursive: true });
  await writeFile(path3.join(options.appDir, "package.json"), JSON.stringify({
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
    shell: process.platform === "win32",
    timeoutMs: 45 * 6e4
  });
  if (!result.ok) {
    throw new Error(`npm install @deepseek-ai/dsh@${options.version} failed (exit ${String(result.code)})
${result.tail.join("\n")}`);
  }
  return { appDir: options.appDir, nodeModules: path3.join(options.appDir, "node_modules") };
}
async function overlayFrontend(options) {
  const log = options.log ?? (() => {
  });
  const frontend = path3.join(options.appDir, "node_modules", "@deepseek-ai", "dsh-web-frontend");
  const packageFile = path3.join(frontend, "package.json");
  if (!existsSync2(packageFile)) {
    throw new Error(`cannot find @deepseek-ai/dsh-web-frontend under ${options.appDir}`);
  }
  const target = path3.join(frontend, "dist");
  await rm(target, { recursive: true, force: true });
  await cp(options.dist, target, { recursive: true });
  if (!existsSync2(path3.join(target, "index.html"))) {
    throw new Error("the built web frontend has no index.html after the copy");
  }
  log(`frontend installed at ${target}`);
  return target;
}
async function patchInstalledClient(options) {
  const log = options.log ?? (() => {
  });
  const picker = path3.join(
    options.appDir,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-directory-picker-browse",
    "lib",
    "client.js"
  );
  const login = path3.join(
    options.appDir,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-settings-account",
    "lib",
    "client.js"
  );
  for (const file of [picker, login]) {
    if (!existsSync2(file)) throw new Error(`installed client bundle is missing: ${file}`);
  }
  const steps = [
    { file: picker, script: path3.join(options.repositoryRoot, "code", "gate", "patch-picker.mjs"), marker: "dsh-picker-patched" },
    { file: login, script: path3.join(options.repositoryRoot, "code", "gate", "patch-login.mjs"), marker: "dsh-gate-account-login" }
  ];
  for (const step of steps) {
    log(`patching ${path3.basename(path3.dirname(path3.dirname(step.file)))} client bundle`);
    const result = await runCommand(process.execPath, [step.script, step.file], {
      cwd: options.repositoryRoot,
      log,
      timeoutMs: 12e4
    });
    if (!result.ok) throw new Error(`client bundle patch failed: ${step.script}
${result.tail.join("\n")}`);
    const text = await readFile3(step.file, "utf8");
    if (!text.includes(step.marker)) throw new Error(`client bundle patch did not leave its marker: ${step.file}`);
    await rm(`${step.file}.orig`, { force: true });
  }
  return { picker, login };
}
async function assembleRuntimePackage(options) {
  const log = options.log ?? (() => {
  });
  const { packageDir, manifest } = await assembleWebPackage(options);
  const appDir = path3.join(packageDir, "app");
  await mkdir(appDir, { recursive: true });
  await installAppDependencies({
    appDir,
    version: options.dshVersion,
    target: options.target,
    log
  });
  await patchInstalledClient({ appDir, repositoryRoot: options.repositoryRoot, log });
  await overlayFrontend({ appDir, dist: options.dist, log });
  await installNodeRuntime({
    version: options.nodeVersion,
    target: options.target,
    cacheDir: options.cacheDir,
    destination: path3.join(packageDir, "runtime", "node"),
    fetchImpl: options.fetchImpl,
    log
  });
  for (const file of ["install.ps1", "start.ps1", "stop.ps1", "start.cmd", "stop.cmd", "start-stack.ps1"]) {
    await copyIfExists(path3.join(options.repositoryRoot, "code", file), path3.join(packageDir, file));
  }
  await writeFile(path3.join(packageDir, ".offline-payload"), "dsh-mesh\n", "utf8");
  await writeFile(path3.join(packageDir, "VERSION"), `${options.dshVersion}
`, "utf8");
  const updated = {
    ...manifest,
    kind: "offline-runtime",
    dshVersion: options.dshVersion,
    nodeVersion: options.nodeVersion,
    files: (await listFiles(packageDir)).length
  };
  await writeFile(path3.join(packageDir, "manifest.json"), JSON.stringify(updated, null, 2), "utf8");
  return { packageDir, manifest: updated };
}

// code/build/job.mjs
function defaultJobRoot() {
  return path4.join(os3.homedir(), ".dsh", "mesh", "build");
}
function defaultCacheDir() {
  return path4.join(os3.homedir(), ".dsh", "mesh", "cache");
}
async function createJob(options = {}) {
  const root = options.root ?? defaultJobRoot();
  const id = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`;
  const dir = path4.join(root, id);
  await mkdir2(dir, { recursive: true });
  const state = {
    id,
    dir,
    status: "created",
    phase: "created",
    source: options.source ?? DEFAULT_SOURCE,
    ref: options.ref ?? DEFAULT_REF,
    targets: options.targets ?? [...DEFAULT_TARGETS],
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
  return JSON.parse(await readFile4(path4.join(dir, "state.json"), "utf8"));
}
async function writeState(dir, state) {
  const file = path4.join(dir, "state.json");
  const temporary = `${file}.tmp`;
  await writeFile2(temporary, JSON.stringify({ ...state, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), "utf8");
  await rename2(temporary, file);
}
async function appendLog(dir, line) {
  await appendFile(path4.join(dir, "build.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, "utf8");
}
async function readLogTail(dir, lines = 80) {
  try {
    const text = await readFile4(path4.join(dir, "build.log"), "utf8");
    return text.trimEnd().split(/\r?\n/u).slice(-lines);
  } catch {
    return [];
  }
}
async function updateState(dir, patch) {
  const state = { ...await readState(dir), ...patch };
  await writeState(dir, state);
  return state;
}
async function runJob(dir, options) {
  const repositoryRoot = options.repositoryRoot;
  const recipesPath = options.recipesPath ?? path4.join(repositoryRoot, "build", "recipes.json");
  const overlayRoot = options.overlayRoot ?? path4.join(repositoryRoot, "build", "overlays");
  let state = await readState(dir);
  const log = (line) => {
    void appendLog(dir, line);
  };
  try {
    state = await updateState(dir, { status: "running", phase: "prepare", error: null });
    const prepared = options.reuseWorktree === true && existsSync3(path4.join(dir, "src")) ? { dir: path4.join(dir, "src"), source: state.source, ref: state.ref, local: false, archiveSha256: state.archiveSha256 ?? null } : await prepareSource({
      source: state.source,
      ref: state.ref,
      cacheDir: options.cacheDir ?? defaultCacheDir(),
      workDir: dir,
      log
    });
    state = await updateState(dir, {
      phase: "apply",
      source: prepared.source,
      ref: prepared.ref,
      worktree: prepared.dir,
      archiveSha256: prepared.archiveSha256 ?? null
    });
    const recipes = await loadRecipes(recipesPath);
    const result = await applyRecipes({ dir: prepared.dir, recipes, overlayRoot, log });
    if (!result.ok) {
      const order = await writeWorkOrder({
        dir: path4.join(dir, "work-order"),
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
        applied: result.applied,
        skipped: result.skipped,
        mismatchCount: 0
      });
      log("plan complete: every overlay applies");
      return state;
    }
    state = await updateState(dir, { phase: "build", applied: result.applied, skipped: result.skipped });
    const built = await runWebBuild({
      dir: prepared.dir,
      log,
      install: options.install,
      build: options.build
    });
    if (!built.ok) {
      state = await updateState(dir, { status: "build-failed", phase: "build", error: built.error ?? "web build failed" });
      log(`build failed: ${built.error ?? "unknown error"}`);
      return state;
    }
    const version = options.version ?? await readSourceVersion(prepared.dir);
    state = await updateState(dir, { phase: "package", version, dist: built.dist });
    const artifacts = [];
    const full = options.full !== false;
    for (const target of state.targets) {
      const shared = {
        dist: built.dist,
        target,
        outputDir: path4.join(dir, "dist"),
        version,
        repositoryRoot,
        source: state.source,
        ref: state.ref,
        tree: recipes.tree ?? null,
        log
      };
      const assembled = full ? await assembleRuntimePackage({
        ...shared,
        dshVersion: version,
        nodeVersion: options.nodeVersion ?? process.versions.node,
        cacheDir: options.cacheDir ?? defaultCacheDir()
      }) : await assembleWebPackage(shared);
      const archive = await archivePackage(assembled.packageDir, target, { log });
      const info = await stat2(archive);
      artifacts.push({
        target,
        packageDir: assembled.packageDir,
        archive,
        bytes: info.size,
        manifest: assembled.manifest
      });
      log(`packaged ${target}: ${archive}`);
    }
    state = await updateState(dir, { status: "done", phase: "done", artifacts });
    log("build complete");
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed: ${message}`);
    state = await updateState(dir, { status: "failed", phase: "failed", error: message });
    return state;
  }
}
async function learnJob(dir, options) {
  const recipesPath = options.recipesPath ?? path4.join(options.repositoryRoot, "build", "recipes.json");
  const overlayRoot = options.overlayRoot ?? path4.join(options.repositoryRoot, "build", "overlays");
  const state = await readState(dir);
  if (state.worktree === null) throw new Error("this job has no worktree yet");
  const recipes = await loadRecipes(recipesPath);
  const learned = await learnOverlays({
    worktree: state.worktree,
    recipes,
    overlayRoot,
    mismatches: Array.isArray(state.mismatches) ? state.mismatches : []
  });
  await writeFile2(recipesPath, JSON.stringify(learned.recipes, null, 2), "utf8");
  await appendLog(dir, `learned ${String(learned.learned.length)} overlay(s)`);
  return updateState(dir, { learnedAt: (/* @__PURE__ */ new Date()).toISOString(), learned: learned.learned });
}
async function readSourceVersion(worktree) {
  for (const candidate of [
    path4.join(worktree, "apps", "cli", "package.json"),
    path4.join(worktree, "package.json")
  ]) {
    try {
      const pkg = JSON.parse(await readFile4(candidate, "utf8"));
      if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
    } catch {
    }
  }
  return "0.0.0";
}

// code/deploy/engine.mjs
import { createHash as createHash2 } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync4, readFileSync } from "node:fs";
import { copyFile, link, mkdir as mkdir3, mkdtemp, readFile as readFile5, readdir as readdir3, rm as rm3, stat as stat3, writeFile as writeFile3 } from "node:fs/promises";
import { isIP as isIP2 } from "node:net";
import { homedir, tmpdir } from "node:os";
import path5 from "node:path";
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
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path5.join(homedir(), ".dsh");
  const file = path5.join(home, "profiles", "web", "cordis.patch.yml");
  if (!existsSync4(file)) return null;
  let text;
  try {
    text = readFileSync(file, "utf8");
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
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path5.join(homedir(), ".dsh");
  const file = path5.join(home, ".credentials.yaml");
  return existsSync4(file) ? file : null;
}
function formatBytes(value) {
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
function initialDeploySteps() {
  return [
    { key: "upload", label: "\u4E0A\u4F20\u5B89\u88C5\u5305", status: "pending", startedAt: null, finishedAt: null, detail: "", progress: null },
    { key: "prepare", label: "\u89E3\u538B\u5E76\u51C6\u5907\u65B0\u7248\u672C", status: "pending", startedAt: null, finishedAt: null, detail: "", progress: null },
    { key: "activate", label: "\u5207\u6362\u5E76\u91CD\u542F\u670D\u52A1", status: "pending", startedAt: null, finishedAt: null, detail: "", progress: null }
  ];
}
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash2("sha256");
    const stream = createReadStream(file);
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
function inferRole(name) {
  const text = String(name).toLowerCase();
  if (text.includes("wireguard") || text.includes("wg-") || text.includes("control")) return "control";
  if (text.includes("gate")) return "gate";
  return "dsh";
}
function normalizeServices(input, os6) {
  const source = input === void 0 ? DEFAULT_SERVICES[os6] : input;
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
    const command = typeof raw.command === "string" && raw.command.trim() !== "" ? raw.command.trim() : os6 === "linux" ? "start.sh" : "dsh-mesh-service.exe";
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
async function findLatestPackage(repositoryRoot, os6) {
  const dist = path5.join(repositoryRoot, "dist");
  const suffix = os6 === "linux" ? ".tar.gz" : ".zip";
  const prefix = `dsh-mesh-`;
  const marker = `-${os6 === "linux" ? "linux" : "win"}-x64`;
  const entries = await readdir3(dist).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix) || !entry.includes(marker)) continue;
    const file = path5.join(dist, entry);
    const info = await stat3(file).catch(() => null);
    if (info?.isFile()) candidates.push({ file, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`no ${os6} package found in ${dist}; build one or pass --package`);
  }
  return candidates[0].file;
}
async function buildDeployPlan(options) {
  if (typeof options.host !== "string" || options.host.trim() === "") throw new Error("host is required");
  const os6 = normalizeOs(options.os ?? "linux");
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  let packagePath = "";
  let packageInfo = null;
  let sha256 = "";
  if (options.skipPackage !== true) {
    packagePath = options.package ? path5.resolve(options.package) : await findLatestPackage(repositoryRoot, os6);
    packageInfo = await stat3(packagePath);
    if (!packageInfo.isFile()) throw new Error(`package is not a file: ${packagePath}`);
    sha256 = await hashFile(packagePath);
  }
  const release = options.skipPackage === true ? "rollback" : typeof options.release === "string" && options.release.trim() !== "" ? options.release.trim() : `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${sha256.slice(0, 8)}`;
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(release)) {
    throw new Error("release must be 3-80 chars of letters, digits, dot, underscore or dash");
  }
  const appRoot = typeof options.appRoot === "string" && options.appRoot.trim() !== "" ? options.appRoot.trim() : DEFAULT_APP_ROOT[os6];
  const services = normalizeServices(options.services, os6);
  const scope = options.scope === "dsh" ? "dsh" : "all";
  const gatePort = String(options.gatePort ?? "80");
  if (!/^\d{1,5}$/.test(gatePort) || Number(gatePort) > 65535) throw new Error("gatePort is invalid");
  const retention = Number.isSafeInteger(options.retention) ? options.retention : 3;
  if (retention < 2) throw new Error("retention must be at least 2 (current plus previous)");
  const llm = options.llm === false ? null : deployerModelRoute();
  const vpnAddress = isIP2(String(options.host ?? "").trim()) === 0 ? "0.0.0.0" : String(options.host).trim();
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
    // Copied from the deployer so every member shares one gateway password;
    // empty means "generate on the target".
    gatePassword: typeof options.gatePassword === "string" ? options.gatePassword : "",
    user: typeof options.user === "string" && options.user.trim() !== "" ? options.user.trim() : void 0,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === "string" && options.identityFile.trim() !== "" ? path5.resolve(options.identityFile) : void 0,
    os: os6,
    package: { path: packagePath, bytes: packageInfo?.size ?? 0, sha256 },
    release,
    appRoot,
    serviceUser,
    shared: `${appRoot}${os6 === "linux" ? "/shared" : "\\shared"}`,
    current: `${appRoot}${os6 === "linux" ? "/current" : "\\current"}`,
    previous: `${appRoot}${os6 === "linux" ? "/previous" : "\\previous"}`,
    releases: `${appRoot}${os6 === "linux" ? "/releases" : "\\releases"}`,
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
    remotePackage: os6 === "linux" ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}${path5.extname(packagePath)}` : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}${path5.extname(packagePath)}`,
    // The deployer's account grants travel with the deploy so a fresh member
    // needs no QR scan of its own.
    remoteCredentials: os6 === "linux" ? `/tmp/dsh-mesh-${sha256.slice(0, 12)}.account` : `C:\\Windows\\Temp\\dsh-mesh-${sha256.slice(0, 12)}.account`
  };
}
async function probeTarget(options) {
  if (typeof options.host !== "string" || options.host.trim() === "") throw new Error("host is required");
  const os6 = normalizeOs(options.os ?? "linux");
  const user = typeof options.user === "string" && options.user.trim() !== "" ? options.user.trim() : void 0;
  const plan = {
    host: options.host.trim(),
    user,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === "string" && options.identityFile.trim() !== "" ? path5.resolve(options.identityFile) : void 0,
    os: os6
  };
  const runner = new SshRunner(plan);
  if (os6 === "windows") {
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
    const appRoot = root2.trim() !== "" ? root2.trim() : `C:\\Users\\${user ?? "Public"}\\.dsh\\dsh-mesh`;
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
  root="$HOME/.dsh/dsh-mesh"
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
  return `#!/usr/bin/env bash
set -euo pipefail
APP_ROOT=${sh(plan.appRoot)}
RELEASE=${sh(plan.release)}
PACKAGE=${sh(plan.remotePackage)}
NEW="$APP_ROOT/releases/$RELEASE"
SHARED="$APP_ROOT/shared"
CURRENT="$APP_ROOT/current"
mkdir -p "$APP_ROOT/releases" "$SHARED"
if [ -e "$NEW" ]; then
  echo "release already exists: $NEW" >&2
  exit 1
fi
mkdir -p "$NEW"
# One marker per 1000 entries: the deploy engine turns these into the panel's
# extraction progress. Counting first costs a gzip pass but gives an honest
# denominator; printing every path would flood the job log with 78k lines.
printf 'DSH-MESH-EXTRACT-TOTAL %s
' "$(tar -tzf "$PACKAGE" | wc -l | tr -d ' ')"
tar -xzf "$PACKAGE" -C "$NEW" --strip-components=1 --checkpoint=1000 --checkpoint-action=echo='DSH-MESH-EXTRACT %u'

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
${netTune}"$NODE_BIN" - "$SHARED/home/profiles/web" "$NEW/plugins/dsh-mesh" ${llmArgs}<<'DSH_MESH_PROFILE_WIRE'
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
${plan.interop === null || plan.interop === void 0 ? "" : `# The interop service is what lets another member drive a conversation here;
# without it call_member and the panel's conversation list have nothing to talk
# to. It listens on the VPN address only, and authenticates with the gateway
# password instead of keeping a second secret.
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
write_unit dsh-interop.service "$APP_ROOT/current/start-interop.sh"
echo "prepared dsh-interop.service on ${plan.interop.bind}:${plan.interop.port}"
`}systemctl daemon-reload
echo "prepared $RELEASE at $NEW"
`;
}
function buildLinuxActivateScript(plan) {
  const restart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `systemctl restart ${sh(service.name)}`).join("\n");
  const rollbackRestart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `systemctl restart ${sh(service.name)}`).join("\n");
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

restart_services() {
${restart.split("\n").map((line) => `  ${line}`).join("\n")}
}
health() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/__gate/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}
restart_services
if [ -d "/etc/systemd/system/dsh-interop.service.d" ]; then
  systemctl restart dsh-interop.service 2>/dev/null || echo "dsh-interop.service did not start; member delegation stays unavailable" >&2
fi
if ! health; then
  echo "health check failed on $RELEASE; rolling back" >&2
  if [ -n "$OLD" ]; then
    ln -sfn "$OLD" "$CURRENT"
${rollbackRestart.split("\n").map((line) => `    ${line}`).join("\n")}
    systemctl restart dsh-interop.service 2>/dev/null || true
    health || true
  fi
  exit 1
fi
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
systemctl restart dsh-interop.service 2>/dev/null || true
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
New-Item -ItemType Directory -Force -Path (Join-Path $AppRoot 'releases') | Out-Null
New-Item -ItemType Directory -Force -Path $Shared | Out-Null
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
${plan.interop === null || plan.interop === void 0 ? "" : `# The supervisor starts interop, so only its configuration belongs here: bind
# the VPN address, reuse the gateway password as the token, and use the same
# model route the deployer uses.
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
  const restart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `Restart-Service -Name ${ps(service.name)} -Force`).join("\n");
  const rollbackRestart = plan.services.filter((service) => plan.scope === "all" || service.role !== "gate").map((service) => `Restart-Service -Name ${ps(service.name)} -Force -ErrorAction SilentlyContinue`).join("\n");
  return `$ErrorActionPreference = 'Stop'
$AppRoot = ${ps(plan.appRoot)}
$Release = ${ps(plan.release)}
$New = Join-Path $AppRoot "releases\\$Release"
$Current = Join-Path $AppRoot 'current'
$Previous = Join-Path $AppRoot 'previous'
$port = ${ps(plan.gatePort)}
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
if ($LASTEXITCODE -ne 0) { throw "could not switch current to $New" }
function Test-Health {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/__gate/health" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}
${restart}
if (-not (Test-Health)) {
  Write-Error "health check failed on $Release; rolling back"
  if ($old) {
    if (Test-Path $Current) { & cmd.exe /c rmdir "$Current" | Out-Null }
    & cmd.exe /c mklink /J "$Current" "$old" | Out-Null
${rollbackRestart}
    Test-Health | Out-Null
  }
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
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
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
      `upload ${path5.basename(plan.package.path)} to ${plan.remotePackage}`,
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
    const totalBytes = (await stat3(local)).size;
    try {
      await this.#uploadStream(local, remote, totalBytes, onProgress);
    } catch (error) {
      this.log(`streamed upload failed (${error instanceof Error ? error.message : String(error)}); retrying with scp`);
      onProgress?.({ bytes: 0, totalBytes, percent: 0, speed: 0, indeterminate: true });
      const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-P", String(this.plan.port)];
      if (this.plan.identityFile) args.push("-i", this.plan.identityFile);
      args.push(local, `${this.target()}:${remote}`);
      await this.runProcess("scp", args);
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
   * Stream one file to the remote path through `ssh` stdin.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @param {number} totalBytes file size.
   * @param {Function} [onProgress] progress callback.
   * @returns {Promise<void>}
   */
  async #uploadStream(local, remote, totalBytes, onProgress) {
    const windows = this.plan.os === "windows";
    const remoteCommand = windows ? `tar -xf - -C "${path5.win32.dirname(remote)}"` : `cat > ${sh(remote)}`;
    const args = [...this.sshOptions(), this.target(), remoteCommand];
    let tarDir = null;
    let tarName = null;
    if (windows) {
      tarName = path5.win32.basename(remote);
      tarDir = await mkdtemp(path5.join(tmpdir(), "dsh-mesh-upload-"));
      const staged = path5.join(tarDir, tarName);
      try {
        try {
          await link(local, staged);
        } catch {
          await copyFile(local, staged);
        }
      } catch (error) {
        await rm3(tarDir, { recursive: true, force: true }).catch(() => {
        });
        throw error;
      }
    }
    return new Promise((resolve, reject) => {
      const ssh = spawn2("ssh", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const tar = windows ? spawn2("tar", ["-cf", "-", "-C", tarDir, tarName], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) : null;
      const source = tar !== null ? tar.stdout : createReadStream(local);
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
        if (tarDir !== null) void rm3(tarDir, { recursive: true, force: true }).catch(() => {
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
      const child = spawn2(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
  async script(script, os6, onLine) {
    const base = this.sshOptions();
    if (os6 === "linux") {
      const remote = this.plan.sudo ? "sudo -n bash -s" : "bash -s";
      await this.runProcess("ssh", [...base, this.target(), remote], script, onLine);
      return;
    }
    const name = `dsh-deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.ps1`;
    const remotePath = `C:\\Windows\\Temp\\${name}`;
    const localPath = path5.join(tmpdir(), name);
    await writeFile3(localPath, `\uFEFF${script}`, "utf8");
    try {
      await this.upload(localPath, remotePath);
      await this.runProcess(
        "ssh",
        [...base, this.target(), `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${remotePath}"`],
        void 0,
        onLine
      );
    } finally {
      await rm3(localPath, { force: true }).catch(() => {
      });
      await this.runProcess("ssh", [...base, this.target(), `cmd /c del /f "${remotePath}"`]).catch(() => {
      });
    }
  }
};
var DeployManager = class {
  /**
   * @param {{repositoryRoot: string, dataDir: string, log?: (line:string)=>void, runnerFactory?: Function}} options options.
   */
  constructor(options) {
    this.repositoryRoot = options.repositoryRoot;
    this.dataDir = options.dataDir;
    this.logLine = options.log ?? (() => {
    });
    this.runnerFactory = options.runnerFactory ?? ((plan) => new SshRunner(plan, { log: (line) => this.logLine(line) }));
    this.running = /* @__PURE__ */ new Map();
    this.states = /* @__PURE__ */ new Map();
    this.saves = /* @__PURE__ */ new Map();
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
   * @param {object} request deploy options.
   * @returns {Promise<object>} job state.
   */
  async start(request) {
    const plan = await buildDeployPlan({
      ...request,
      gatePassword: typeof request.gatePassword === "string" ? request.gatePassword : process.env.DSH_GATE_PASSWORD,
      repositoryRoot: this.repositoryRoot
    });
    const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path5.join(this.dataDir, id);
    await mkdir3(dir, { recursive: true });
    const stateFile = path5.join(dir, "job.json");
    const logFile = path5.join(dir, "deploy.log");
    const state = {
      id,
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
      steps: initialDeploySteps(),
      progress: { bytes: 0, totalBytes: plan.package.bytes, percent: 0, speed: 0, indeterminate: false }
    };
    if (this.states.size >= 100) {
      const oldest = this.states.keys().next();
      if (!oldest.done) this.states.delete(oldest.value);
    }
    this.states.set(id, state);
    await writeFile3(stateFile, `${JSON.stringify(state, null, 2)}
`, "utf8");
    const log = async (line) => {
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      await writeFile3(logFile, `[${stamp}] ${line}
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
      await log(`uploading to ${plan.remotePackage}`);
      await mark("upload", "running");
      const uploadStarted = Date.now();
      const existingBytes = typeof runner.remoteSize === "function" ? await runner.remoteSize(plan.remotePackage).catch(() => null) : null;
      if (existingBytes === plan.package.bytes) {
        await log(`package already present on the target (${formatBytes(existingBytes)}), skipping upload`);
        meter("\u4E0A\u4F20\u5B89\u88C5\u5305", { bytes: existingBytes, totalBytes: plan.package.bytes, percent: 100 });
        await mark("upload", "succeeded", `${formatBytes(existingBytes)} \xB7 \u5DF2\u5B58\u5728\uFF0C\u8DF3\u8FC7\u4E0A\u4F20`);
      } else {
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
        await mark("upload", "succeeded", `${formatBytes(plan.package.bytes)} \xB7 ${uploadSeconds.toFixed(1)}s \xB7 ${formatBytes(plan.package.bytes / uploadSeconds)}/s`);
      }
      const credentialsFile = deployerCredentialsFile();
      if (credentialsFile !== null) {
        try {
          await runner.upload(credentialsFile, plan.remoteCredentials);
          const helperFile = path5.join(this.repositoryRoot, "code", "shared", "credentials-merge.mjs");
          if (existsSync4(helperFile)) await runner.upload(helperFile, `${plan.remoteCredentials}.mjs`);
          await log("shared the deployer's account sign-in");
        } catch (error) {
          await log(`account sign-in was not shared: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        await log("no deployer account to share (DSH_HOME/.credentials.yaml is missing)");
      }
      state.phase = "prepare";
      await mark("prepare", "running");
      await log("prepare: extract, shared dirs, service definitions (no switch)");
      let preExtracted = false;
      const prepareStep = stepOf("prepare");
      let entries = 0;
      const extractProgress = (done, total, finished = false) => {
        const percent = total > 0 ? finished ? 100 : Math.min(99, Math.round(done / total * 100)) : 0;
        if (prepareStep !== void 0) prepareStep.progress = { done, total, percent };
        meter("\u89E3\u538B\u5B89\u88C5\u5305", { done, total, percent, indeterminate: total === 0 });
      };
      const trackExtract = (line) => {
        const text = line.trim().replace(/^tar:\s*/u, "");
        const head = /^DSH-MESH-EXTRACT-TOTAL (\d+)$/u.exec(text);
        if (head !== null) {
          entries = Number.parseInt(head[1], 10);
          extractProgress(0, entries);
          return true;
        }
        const tick = /^DSH-MESH-EXTRACT (\d+)$/u.exec(text);
        if (tick !== null) {
          extractProgress(Number.parseInt(tick[1], 10) * EXTRACT_CHECKPOINT, entries);
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
    await writeFile3(stateFile, `${JSON.stringify(state, null, 2)}
`, "utf8");
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
      return JSON.parse(await readFile5(path5.join(this.dataDir, id, "job.json"), "utf8"));
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
      entries = await readdir3(this.dataDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("deploy-")) continue;
      try {
        jobs.push(JSON.parse(await readFile5(path5.join(this.dataDir, entry.name, "job.json"), "utf8")));
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
      const text = await readFile5(path5.join(this.dataDir, id, "deploy.log"), "utf8");
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
    const dir = path5.join(this.dataDir, id);
    await mkdir3(dir, { recursive: true });
    const stateFile = path5.join(dir, "job.json");
    const logFile = path5.join(dir, "deploy.log");
    const state = {
      id,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: "rollback",
      status: "running",
      phase: "rollback",
      error: null
    };
    await writeFile3(stateFile, `${JSON.stringify(state, null, 2)}
`, "utf8");
    const log = async (line) => {
      const stamp = (/* @__PURE__ */ new Date()).toISOString();
      await writeFile3(logFile, `[${stamp}] ${line}
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

// code/shared/cluster.mjs
import { createHash as createHash3, createHmac, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
function deriveClusterSecret(password) {
  if (typeof password !== "string" || password === "") return "";
  return createHash3("sha256").update("dsh-mesh/cluster/v1\0").update(password, "utf8").digest("hex");
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
function payloadOf(method, path10, timestamp, nonce) {
  return [VERSION, String(method).toUpperCase(), path10, String(timestamp), nonce].join("\n");
}

// code/build/repack.mjs
import { execFile } from "node:child_process";
import { createHash as createHash4 } from "node:crypto";
import { cp as cp2, mkdir as mkdir4, mkdtemp as mkdtemp2, readFile as readFile6, readdir as readdir4, rm as rm4, stat as stat4, writeFile as writeFile4 } from "node:fs/promises";
import { createReadStream as createReadStream2, existsSync as existsSync5 } from "node:fs";
import path6 from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
var CODE_SCRIPTS = ["install.sh", "start.sh", "stop.sh", "status.sh", "doctor.sh", "install.ps1", "start.ps1", "stop.ps1", "start.cmd", "stop.cmd", "start-stack.ps1"];
var ROOT_SCRIPTS = ["start-interop.sh", "install-interop-service.sh", "uninstall-interop-service.sh"];
var PLUGIN_FILES = ["index.js", "client.js", "cordis.patch.yml", "package.json"];
var PLUGIN_DIRS = ["locale", "build", "code/build", "code/shared"];
var CODE_DIRS = ["windows-service", "interop-service", "wireguard"];
async function clear(target) {
  await rm4(target, { recursive: true, force: true });
}
async function replaceDirectory(from, to) {
  if (!existsSync5(from)) return;
  await clear(to);
  await cp2(from, to, { recursive: true });
}
async function replaceFile(from, to) {
  if (!existsSync5(from)) return;
  await clear(to);
  await cp2(from, to);
}
async function countFiles(dir) {
  let total = 0;
  for (const entry of await readdir4(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(path6.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}
async function repackDirectory(packageDir, repositoryRoot) {
  const manifestFile = path6.join(packageDir, "manifest.json");
  if (!existsSync5(manifestFile)) throw new Error(`${packageDir} is not an extracted package (no manifest.json)`);
  await replaceDirectory(path6.join(repositoryRoot, "code", "gate"), path6.join(packageDir, "gate"));
  await replaceDirectory(path6.join(repositoryRoot, "code", "shared"), path6.join(packageDir, "shared"));
  await replaceDirectory(path6.join(repositoryRoot, "code", "config"), path6.join(packageDir, "config"));
  for (const name of CODE_DIRS) {
    await replaceDirectory(path6.join(repositoryRoot, "code", name), path6.join(packageDir, "code", name));
  }
  await replaceDirectory(path6.join(repositoryRoot, "docs"), path6.join(packageDir, "docs"));
  for (const name of CODE_SCRIPTS) {
    await replaceFile(path6.join(repositoryRoot, "code", name), path6.join(packageDir, name));
  }
  for (const name of ROOT_SCRIPTS) {
    await replaceFile(path6.join(repositoryRoot, name), path6.join(packageDir, name));
  }
  for (const name of PLUGIN_FILES) {
    await replaceFile(path6.join(repositoryRoot, name), path6.join(packageDir, "plugins", "dsh-mesh", name));
  }
  for (const name of PLUGIN_DIRS) {
    await replaceDirectory(path6.join(repositoryRoot, name), path6.join(packageDir, "plugins", "dsh-mesh", name));
  }
  const manifest = JSON.parse(await readFile6(manifestFile, "utf8"));
  const staticAssets = await collectStaticAssets(path6.join(packageDir, "gate"));
  manifest.staticAssets = staticAssets;
  manifest.builtAt = (/* @__PURE__ */ new Date()).toISOString();
  manifest.repackedFrom = "code/build/repack.mjs";
  manifest.files = await countFiles(packageDir);
  await writeFile4(manifestFile, `${JSON.stringify(manifest, null, 2)}
`, "utf8");
  const clientBytes = (await stat4(path6.join(packageDir, "plugins", "dsh-mesh", "client.js"))).size;
  return { packageDir, version: manifest.version, target: manifest.target, files: manifest.files, clientBytes };
}
async function sha256File2(file) {
  const hash = createHash4("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream2(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}
function archiveRootName(file) {
  return path6.basename(file).replace(/\.(tar\.gz|tgz|zip)$/u, "");
}
async function extractArchive(file, directory) {
  await mkdir4(directory, { recursive: true });
  if (file.endsWith(".zip")) {
    try {
      await run("unzip", ["-q", file, "-d", directory]);
    } catch {
      await run("tar", ["-xf", file, "-C", directory]);
    }
  } else {
    await run("tar", ["-xzf", file, "-C", directory]);
  }
  const root = path6.join(directory, archiveRootName(file));
  if (!existsSync5(path6.join(root, "manifest.json"))) {
    throw new Error(`archive ${path6.basename(file)} has no ${archiveRootName(file)}/manifest.json`);
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
  const work = await mkdtemp2(path6.join(path6.dirname(file), ".repack-"));
  try {
    log(`extracting ${path6.basename(file)}`);
    const packageDir = await extractArchive(file, work);
    const summary = await repackDirectory(packageDir, repositoryRoot);
    log(`replaced gateway, scripts and plugin files (${String(summary.files)} files in the package)`);
    const parent = path6.dirname(packageDir);
    const name = path6.basename(packageDir);
    await compressDirectory(parent, name, file);
    const bytes = (await stat4(file)).size;
    const sha256 = await sha256File2(file);
    await writeFile4(`${file}.sha256`, `${sha256}  ${path6.basename(file)}

`, "utf8");
    log(`wrote ${path6.basename(file)} (${String(bytes)} bytes)`);
    return { package: file, version: summary.version, target: summary.target, bytes, sha256, files: summary.files };
  } finally {
    await rm4(work, { recursive: true, force: true });
  }
}

// code/shared/system-info.mjs
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync6, readFileSync as readFileSync2, statfsSync } from "node:fs";
import os4 from "node:os";
import { promisify as promisify2 } from "node:util";
var execFileAsync = promisify2(execFile2);
function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function safeNumber(value) {
  return Number.isFinite(value) ? value : 0;
}
function quickSystemInfo(options = {}) {
  const cpus = os4.cpus();
  const total = os4.totalmem();
  const free = os4.freemem();
  const used = Math.max(0, total - free);
  let cpuTotal = 0;
  let cpuIdle = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    cpuTotal += times.user + times.nice + times.sys + times.irq + times.idle;
    cpuIdle += times.idle;
  }
  const cpuUsage = cpuTotal === 0 ? 0 : round((1 - cpuIdle / cpuTotal) * 100, 1);
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
    hostname: os4.hostname(),
    platform: process.platform,
    arch: process.arch,
    home: options.home ?? os4.homedir(),
    appRoot: options.appRoot ?? process.env.DSH_PACKAGE_ROOT ?? process.cwd(),
    user: os4.userInfo().username,
    cpu: { model: cpus[0]?.model ?? "unknown", cores: cpus.length, usagePercent: cpuUsage },
    memory: {
      totalBytes: total,
      freeBytes: free,
      usedBytes: used,
      usedPercent: total === 0 ? 0 : round(used / total * 100, 1)
    },
    disks
  };
}

// src/lib/service.mjs
var HERE = path7.dirname(fileURLToPath(import.meta.url));
var PROBE_GRACE_MS = 45e3;
var PROBE_RETRY_MS = 3e3;
function findRepositoryRoot(start) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync7(path7.join(current, "build", "recipes.json")) && existsSync7(path7.join(current, "code", "build"))) {
      return current;
    }
    const parent = path7.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path7.resolve(start, "..", "..");
}
var REPOSITORY_ROOT = findRepositoryRoot(HERE);
function packageVersion() {
  try {
    const parsed = JSON.parse(readFileSync3(path7.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
var MeshService = class {
  /**
   * @param {{dataDir: string, config?: object, log?: (line: string) => void}} options service input.
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.config = options.config ?? {};
    this.logLine = options.log ?? (() => {
    });
    this.jobRoot = path7.join(this.dataDir, "build");
    this.cacheDir = path7.join(this.dataDir, "cache");
    this.version = packageVersion();
    this.repositoryRoot = REPOSITORY_ROOT;
    this.recipesPath = path7.join(REPOSITORY_ROOT, "build", "recipes.json");
    this.overlayRoot = path7.join(REPOSITORY_ROOT, "build", "overlays");
    this.home = path7.dirname(this.dataDir);
    this.deployRoot = path7.join(this.dataDir, "deploy");
    this.memberTagsFile = path7.join(this.dataDir, "member-tags.json");
    this.packagesDir = path7.join(os5.homedir(), ".dsh", "packages");
    this.deploy = new DeployManager({
      repositoryRoot: REPOSITORY_ROOT,
      dataDir: this.deployRoot,
      log: (line) => this.logLine(`deploy: ${line}`)
    });
    this.running = /* @__PURE__ */ new Map();
    this.systemCache = null;
    this.probes = /* @__PURE__ */ new Map();
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
    await this.deploy.dispose();
  }
  /**
   * Local host and WireGuard facts.
   * @returns {Promise<object>} status.
   */
  async status() {
    const stateFile = path7.join(this.home, "wireguard", "state.json");
    const { state, error } = await readWireGuardState({ file: stateFile });
    const identity = state === null ? null : wireGuardIdentity(state);
    return {
      ok: true,
      host: {
        hostname: os5.hostname(),
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
    const path10 = "/__gate/cluster/__gate/session/promote";
    const response = await fetch(`http://${host}${path10}`, {
      method: "POST",
      headers: { [CLUSTER_HEADER]: signClusterRequest(deriveClusterSecret(password), { method: "POST", path: path10 }) }
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
    const stateFile = path7.join(this.home, "wireguard", "state.json");
    const { state, error } = await readWireGuardState({ file: stateFile });
    const identity = state === null ? null : wireGuardIdentity(state);
    const self = {
      id: "local",
      kind: "self",
      name: identity?.selfName ?? os5.hostname(),
      ip: identity?.selfIp ?? "",
      online: true,
      dsh: true,
      port: null,
      latencyMs: 0,
      gate: null,
      system: await this.systemInfo(),
      error: null
    };
    const snapshot = await discoverMembers({
      state,
      stateError: error,
      self,
      ports: Array.isArray(this.config.memberPorts) ? this.config.memberPorts : [80, 8080]
    });
    const tags = await this.memberTags();
    self.tag = tags[self.id] ?? null;
    const ports = Array.isArray(this.config.memberPorts) ? this.config.memberPorts : [80, 8080];
    const now = Date.now();
    const members = await Promise.all(snapshot.members.map(async (member) => {
      const tag = tags[member.id] ?? null;
      const known = this.probes.get(member.ip);
      if (member.dsh) {
        this.probes.set(member.ip, {
          port: member.port,
          gate: member.gate,
          system: member.system,
          latencyMs: member.latencyMs,
          at: now
        });
        return { ...member, tag };
      }
      if (known === void 0) return { ...member, tag };
      const retryPorts = known.port === null ? ports : [known.port];
      const retry = await probeMember(member.ip, { ports: retryPorts, timeoutMs: PROBE_RETRY_MS }).catch(() => null);
      if (retry !== null && retry.ok) {
        this.probes.set(member.ip, {
          port: retry.port,
          gate: retry.info,
          system: retry.info?.system ?? null,
          latencyMs: retry.latencyMs,
          at: now
        });
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
      if (now - known.at > PROBE_GRACE_MS) return { ...member, tag };
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
    if (this.probes.size > 64) {
      for (const [ip, cached] of this.probes) {
        if (now - cached.at > PROBE_GRACE_MS) this.probes.delete(ip);
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
      const parsed = JSON.parse(await readFile7(this.memberTagsFile, "utf8"));
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
    await mkdir5(this.dataDir, { recursive: true });
    await writeFile5(this.memberTagsFile, `${JSON.stringify(tags, null, 2)}
`, "utf8");
    return { ok: true, tags };
  }
  /**
   * Remove the files left by earlier builds.
   *
   * Called after a build finishes, with the just-finished job id as `keep`, so
   * the new `src/`, `work-order/` and `dist/` survive. All older jobs lose
   * their worktree, work order and (unless `keepDist`) their package.
   * `state.json` and `build.log` are always kept for postmortem.
   * @param {{keep?: string, keepDist?: boolean}} [options] job to preserve and whether to retain old packages.
   * @returns {Promise<string[]>} ids whose outputs were removed.
   */
  async cleanupBuilds(options = {}) {
    if (!existsSync7(this.jobRoot)) return [];
    const entries = await readdir5(this.jobRoot, { withFileTypes: true });
    const removed = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path7.join(this.jobRoot, entry.name);
      let state;
      try {
        state = await readState(dir);
      } catch {
        continue;
      }
      if (this.running.has(state.id)) continue;
      if (state.id === options.keep) continue;
      await rm5(path7.join(dir, "src"), { recursive: true, force: true });
      await rm5(path7.join(dir, "work-order"), { recursive: true, force: true });
      if (options.keepDist !== true) await rm5(path7.join(dir, "dist"), { recursive: true, force: true });
      removed.push(state.id);
    }
    return removed;
  }
  /**
   * Start one build job in the background.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string, keepDist?: boolean}} request build request.
   * @returns {Promise<object>} the initial job state.
   */
  async startBuild(request = {}) {
    const defaults = await this.status();
    const source = (typeof request.source === "string" && request.source !== "" ? request.source : defaults.build.source) || DEFAULT_SOURCE;
    const ref = (typeof request.ref === "string" && request.ref !== "" ? request.ref : defaults.build.ref) || DEFAULT_REF;
    const targets = Array.isArray(request.targets) && request.targets.length > 0 ? request.targets : defaults.build.targets;
    const job = await createJob({ root: this.jobRoot, source, ref, targets });
    this.logLine(`mesh build job ${job.id} created`);
    const promise = runJob(job.dir, {
      repositoryRoot: this.repositoryRoot,
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot,
      cacheDir: this.cacheDir,
      planOnly: request.planOnly === true,
      version: request.version,
      full: this.config.build?.full !== false,
      nodeVersion: typeof this.config.build?.nodeVersion === "string" && this.config.build.nodeVersion !== "" ? this.config.build.nodeVersion : void 0
    }).catch((error) => {
      this.logLine(`mesh build job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.running.delete(job.id);
    });
    this.running.set(job.id, promise);
    return { ...job.state, dir: job.dir, running: true };
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
    const promise = runJob(dir, {
      repositoryRoot: this.repositoryRoot,
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot,
      cacheDir: this.cacheDir,
      reuseWorktree: true,
      full: this.config.build?.full !== false,
      nodeVersion: typeof this.config.build?.nodeVersion === "string" && this.config.build.nodeVersion !== "" ? this.config.build.nodeVersion : void 0
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
      logFile: path7.join(dir, "build.log"),
      stateFile: path7.join(dir, "state.json"),
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
    if (!existsSync7(this.jobRoot)) return [];
    const entries = await readdir5(this.jobRoot, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const state = await readState(path7.join(this.jobRoot, entry.name));
        jobs.push({
          id: state.id,
          status: state.status,
          phase: state.phase,
          source: state.source,
          ref: state.ref,
          targets: state.targets,
          updatedAt: state.updatedAt
        });
      } catch {
      }
    }
    return jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
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
    const parsed = JSON.parse(await readFile7(this.recipesPath, "utf8"));
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
    const entries = await readdir5(this.packagesDir, { withFileTypes: true }).catch(() => []);
    const packages = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(?:zip|tar\.gz|tgz)$/iu.test(entry.name)) continue;
      const file = path7.join(this.packagesDir, entry.name);
      const info = await stat5(file).catch(() => null);
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
   * Resolve a package path from an absolute path, `~/.dsh/packages/<name>`,
   * or the repository `dist/<name>`.
   * @param {string} input package path or filename.
   * @returns {Promise<string>} absolute package path.
   */
  async resolvePackage(input) {
    const raw = typeof input === "string" ? input.trim() : "";
    if (raw === "") throw new Error("package is required");
    const candidates = path7.isAbsolute(raw) ? [raw] : [path7.join(this.packagesDir, raw), path7.join(this.repositoryRoot, "dist", raw)];
    for (const file of candidates) {
      const info = await stat5(file).catch(() => null);
      if (info?.isFile()) return file;
    }
    throw new Error(`package not found: ${raw}`);
  }
  /**
   * Resolve a target and start a deployment job.
   *
   * This is the single entry point used by both the panel API and the model
   * tool. The caller decides whether to wait by calling `deployPackage()`;
   * the panel keeps the historical non-blocking `deployMember()` wrapper.
   * @param {{host?: string, member?: string, package?: string}} request target and package.
   * @returns {Promise<{ok: boolean, job: object, member: object|null, packagePath: string}>} started job.
   */
  async startDeploy(request) {
    const host = typeof request.host === "string" ? request.host.trim() : "";
    const memberId = typeof request.member === "string" ? request.member.trim() : "";
    const packagePath = await this.resolvePackage(request.package);
    const snapshot = await this.members();
    const all = [snapshot.local, ...snapshot.members].filter(Boolean);
    const member = memberId !== "" ? all.find((candidate) => candidate.id === memberId) : all.find((candidate) => candidate.id === host || candidate.name === host || candidate.ip === host);
    if (memberId !== "" && member === void 0) throw new Error(`member not found: ${memberId}`);
    if (member !== void 0) {
      const os7 = /win(?:dows)?/iu.test(path7.basename(packagePath)) ? "windows" : member.system?.platform?.toLowerCase().startsWith("win") ? "windows" : "linux";
      const deployRequest = await this.#memberDeployRequest(member, packagePath, os7);
      const started2 = await this.deploy.start({ ...deployRequest, member: member.id });
      return {
        ok: true,
        job: started2.job,
        member: { id: member.id, name: member.name, ip: member.ip },
        packagePath
      };
    }
    if (host === "") throw new Error("host is required");
    const os6 = /win(?:dows)?/iu.test(path7.basename(packagePath)) ? "windows" : "linux";
    const appRoot = os6 === "windows" ? "C:\\dsh-mesh" : "/opt/dsh-mesh";
    const started = await this.deploy.start({ host, package: packagePath, os: os6, appRoot });
    return { ok: true, job: started.job, member: null, packagePath };
  }
  /**
   * Deploy one local package to a discovered member, without waiting.
   * Kept for the panel API, which returns a job id immediately.
   * @param {{member?: string, package?: string}} request member id/ip and package filename.
   * @returns {Promise<object>} started deploy job.
   */
  async deployMember(request) {
    const result = await this.startDeploy({ member: request.member, package: request.package });
    return {
      ok: true,
      job: result.job,
      member: result.member,
      packagesDir: this.packagesDir
    };
  }
  /**
   * Deploy one package to an SSH host, synchronously.
   *
   * The host may be a discovered member id/name/IP, in which case the member's
   * OS, install root and WireGuard SSH metadata are used; otherwise the host is
   * treated as a plain SSH target and the package platform decides the OS.
   * @param {{host?: string, package?: string}} request target host and package.
   * @returns {Promise<{job: object|null, logFile: string, log: string, member?: object}>} final result.
   */
  async deployPackage(request) {
    const started = await this.startDeploy({ host: request.host, package: request.package });
    const job = await this.deploy.wait(started.job.id);
    return {
      job,
      member: started.member,
      logFile: path7.join(this.deployRoot, started.job.id, "deploy.log"),
      log: await this.deployLogs(started.job.id, 80)
    };
  }
  /**
   * Build the deployment request for a discovered member.
   * @param {object} member member snapshot.
   * @param {string} packagePath package file.
   * @param {'linux'|'windows'} os target OS.
   * @returns {Promise<object>} deploy request.
   */
  async #memberDeployRequest(member, packagePath, os6) {
    if (member.ip === "") throw new Error(`member ${member.id} has no VPN address`);
    let user = "root";
    let identityFile;
    const { state } = await readWireGuardState({ file: path7.join(this.home, "wireguard", "state.json") });
    const peer = state?.server?.peers?.find((candidate) => candidate?.ip === member.ip);
    if (peer !== void 0 && peer !== null) {
      if (typeof peer.sshUser === "string" && peer.sshUser !== "") user = peer.sshUser;
      if (typeof peer.publicKey === "string" && peer.publicKey !== "") {
        const digest = createHash5("sha256").update(peer.publicKey).digest("hex");
        const candidate = path7.join(this.home, "wireguard", "ssh", `${digest}.key`);
        if (existsSync7(candidate)) identityFile = candidate;
      }
    }
    const system = member.system;
    let appRoot = typeof system?.appRoot === "string" && system.appRoot.trim() !== "" ? system.appRoot.trim() : void 0;
    let serviceUser = typeof system?.user === "string" && system.user.trim() !== "" ? system.user.trim() : void 0;
    if (appRoot === void 0) {
      try {
        const detected = await this.deploy.inspectTarget({ host: member.ip, user, identityFile, os: os6 });
        appRoot = detected.appRoot;
        serviceUser = serviceUser ?? detected.serviceUser;
      } catch {
      }
    }
    if (appRoot === void 0 && typeof system?.home === "string" && system.home.trim() !== "") {
      const home = system.home.trim().replace(/[\\/]+$/u, "");
      appRoot = os6 === "windows" ? `${home}\\.dsh\\dsh-mesh` : `${home}/.dsh/dsh-mesh`;
    }
    if (appRoot === void 0) {
      const home = os6 === "windows" ? `C:\\Users\\${user}` : user === "root" ? "/root" : `/home/${user}`;
      appRoot = os6 === "windows" ? `${home}\\.dsh\\dsh-mesh` : `${home}/.dsh/dsh-mesh`;
    }
    return {
      host: member.ip,
      user,
      identityFile,
      os: os6,
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
   * Resolve and validate one job directory.
   * @param {string} id job id.
   * @returns {string} path.
   */
  _jobDir(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/u.test(id)) throw new Error("invalid job id");
    const dir = path7.resolve(this.jobRoot, id);
    if (!dir.startsWith(`${path7.resolve(this.jobRoot)}${path7.sep}`)) throw new Error("invalid job id");
    return dir;
  }
};

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
async function readJson(request) {
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
function registerApi(ctx, service) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (request, response) => {
      try {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", "http://local.invalid");
        const path10 = url.pathname.slice(API_PREFIX.length) || "/";
        if (method === "GET" && path10 === "/status") {
          writeJson(response, 200, await service.status());
          return;
        }
        if (method === "GET" && path10 === "/members") {
          writeJson(response, 200, await service.members());
          return;
        }
        if (method === "GET" && path10 === "/member-tags") {
          writeJson(response, 200, { ok: true, tags: await service.memberTags() });
          return;
        }
        if (method === "POST" && path10 === "/conversations/send") {
          const body = await readJson(request);
          writeJson(response, 200, await service.sendConversation({
            text: typeof body.text === "string" ? body.text : "",
            members: Array.isArray(body.members) ? body.members.filter((item) => typeof item === "string") : []
          }));
          return;
        }
        if (method === "POST" && path10 === "/conversations/clear") {
          writeJson(response, 200, await service.clearConversations());
          return;
        }
        if (method === "GET" && path10 === "/conversations") {
          writeJson(response, 200, await service.conversations());
          return;
        }
        if (method === "GET" && path10 === "/jobs") {
          writeJson(response, 200, { ok: true, jobs: await service.jobs() });
          return;
        }
        if (method === "GET" && path10 === "/packages") {
          writeJson(response, 200, await service.packages());
          return;
        }
        if (method === "GET" && path10 === "/deploy/jobs") {
          writeJson(response, 200, { ok: true, jobs: await service.deployJobs(30) });
          return;
        }
        if (method === "GET") {
          const deployRead = /^\/deploy\/([^/]+)(\/log)?$/u.exec(path10);
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
          const read = /^\/build\/([^/]+)(\/log)?$/u.exec(path10);
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
        if (path10 === "/deploy") {
          const body = await readJson(request);
          const result = await service.deployMember({
            member: typeof body.member === "string" ? body.member : void 0,
            package: typeof body.package === "string" ? body.package : void 0
          });
          writeJson(response, 202, result);
          return;
        }
        if (path10 === "/session/promote") {
          const body = await readJson(request);
          writeJson(response, 200, await service.promoteSession(String(body.member ?? "")));
          return;
        }
        if (path10 === "/member-tags") {
          const body = await readJson(request);
          writeJson(response, 200, await service.setMemberTag(
            typeof body.id === "string" ? body.id : "",
            typeof body.tag === "string" ? body.tag : ""
          ));
          return;
        }
        if (path10 === "/build") {
          const body = await readJson(request);
          const job = await service.startBuild({
            source: typeof body.source === "string" ? body.source : void 0,
            ref: typeof body.ref === "string" ? body.ref : void 0,
            targets: Array.isArray(body.targets) ? body.targets.filter((value) => typeof value === "string") : void 0,
            planOnly: body.planOnly === true,
            version: typeof body.version === "string" ? body.version : void 0
          });
          writeJson(response, 202, { ok: true, job });
          return;
        }
        const resume = /^\/build\/([^/]+)\/resume$/u.exec(path10);
        if (resume !== null) {
          writeJson(response, 202, { ok: true, job: await service.resumeBuild(resume[1]) });
          return;
        }
        const match = /^\/build\/([^/]+)\/learn$/u.exec(path10);
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

// src/lib/member-tasks.mjs
import { randomUUID } from "node:crypto";
import { mkdir as mkdir6, readFile as readFile8, readdir as readdir6, rename as rename3, writeFile as writeFile6 } from "node:fs/promises";
import { existsSync as existsSync8, readFileSync as readFileSync4 } from "node:fs";
import path8 from "node:path";
var DEFAULT_INTEROP_PORT = 8765;
var WAIT_TIMEOUT_MS = 6e4;
var MAX_ATTEMPTS = 30;
var LOST_CONVERSATION = /conversation not found|unknown SDK session|session "?[\w-]+"? already exists|SDK session is already open or opening|session agent was disposed/iu;
var EMPTY_TURN = "\u76EE\u6807\u7684 DSH \u5728\u4EFB\u52A1\u6267\u884C\u671F\u95F4\u91CD\u542F\u4E86\uFF1A\u5BF9\u8BDD\u6CA1\u6709\u4EA7\u751F\u4EFB\u4F55\u8F93\u51FA\uFF0C\u8FD9\u4E00\u8F6E\u5DF2\u4E2D\u65AD";
var EMPTY_WAIT_RETRIES = 3;
function envFile(file) {
  const values = {};
  if (!existsSync8(file)) return values;
  for (const raw of readFileSync4(file, "utf8").split(/\r?\n/)) {
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
    this.taskRoot = path8.join(this.dataDir, "member-tasks");
    this.tasks = /* @__PURE__ */ new Map();
    this.monitors = /* @__PURE__ */ new Map();
    this.controllers = /* @__PURE__ */ new Map();
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
    }
  }
  async #ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir6(this.taskRoot, { recursive: true });
    let files = [];
    try {
      files = await readdir6(this.taskRoot);
    } catch {
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const task = JSON.parse(await readFile8(path8.join(this.taskRoot, file), "utf8"));
        if (task?.id === void 0) continue;
        if (task.status === "running" || task.status === "starting") {
          task.status = "interrupted";
          task.error = "the plugin restarted before the member conversation completed";
          await this.#save(task);
        }
        this.tasks.set(task.id, task);
      } catch {
      }
    }
  }
  async #save(task) {
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const file = path8.join(this.taskRoot, `${task.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await mkdir6(this.taskRoot, { recursive: true });
    await writeFile6(temporary, `${JSON.stringify(task, null, 2)}
`, "utf8");
    await rename3(temporary, file);
  }
  async #log(task, line) {
    const text = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}
`;
    try {
      await writeFile6(path8.join(this.taskRoot, `${task.id}.log`), text, { encoding: "utf8", flag: "a" });
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
        path8.join(this.service.repositoryRoot, "..", "config", "gate.env"),
        path8.join(this.service.repositoryRoot, "config", "gate.env"),
        path8.join(this.service.dataDir, "..", "..", "config", "gate.env")
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
      if (signal?.aborted) throw new Error("tool call aborted");
      try {
        return await attempt();
      } catch (error) {
        if (signal?.aborted) throw new Error("tool call aborted");
        const message = error instanceof Error ? error.message : String(error);
        const starting = /SDK runtime is not ready|sdk_unavailable|SDK runtime is still starting/iu.test(message);
        if (!starting || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2e3));
      }
    }
  }
  async start({ member, prompt, cwd, agent, notify = true, signal }) {
    await this.#ensureLoaded();
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("prompt is required");
    if (agent === void 0 || agent === null) throw new Error("delegation must be called from a DSH conversation");
    const target = await this.#resolveMember(member);
    const payload = {
      prompt,
      // The member's panel lists these; without a title it would show a UUID.
      title: truncate(prompt, 80),
      initiator: { ...this.identity ?? { id: "local" }, source: "call_member" },
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
   * Wait for one task up to a bounded timeout. The task monitor keeps running
   * in the background, so a timeout only ends this caller's wait; the caller
   * can call wait again with the same id.
   * @param {string} taskId task id returned by call_member.
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] wait options.
   * @returns {Promise<{done: boolean, timedOut: boolean, task: object}>} outcome.
   */
  async wait(taskId, options = {}) {
    await this.#ensureLoaded();
    const id = String(taskId ?? "");
    if (id === "") throw new Error("taskId is required");
    const timeoutMs = Math.max(1e3, Math.min(Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : 3e4, 3e5));
    const signal = options.signal;
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      if (signal?.aborted) throw new Error("tool call aborted");
      const task = this.tasks.get(id);
      if (task === void 0) throw new Error(`member task not found: ${id}`);
      if (task.status === "completed" || task.status === "failed" || task.status === "interrupted") {
        return { done: true, timedOut: false, task };
      }
      const left = deadline - Date.now();
      if (left <= 0) return { done: false, timedOut: true, task };
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, left)));
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
          { timeoutMs: WAIT_TIMEOUT_MS },
          WAIT_TIMEOUT_MS + 1e4,
          signal
        );
        if (result.timedOut === true) {
          task.status = "running";
          await this.#save(task);
          continue;
        }
        if (this.disposed) break;
        const conversation = result.conversation ?? {};
        task.lastText = typeof conversation.lastText === "string" ? conversation.lastText : "";
        if (conversation.error) task.error = String(conversation.error);
        const status = String(conversation.status ?? "");
        if (status === "interrupted" || status === "unavailable") {
          task.status = "failed";
          task.interrupted = true;
          task.error = String(conversation.error ?? EMPTY_TURN);
          break;
        }
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
    return task;
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
      const text = await readFile8(path8.join(this.taskRoot, `${task.id}.log`), "utf8");
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
    return path8.join(this.taskRoot, `${String(taskId)}.log`);
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
      "\u7528 wait_member \u7B49\u5F85\u7ED3\u679C\uFF1A\u6BCF\u6B21\u6709\u8D85\u65F6\u4E0A\u9650\uFF0C\u8D85\u65F6\u4F1A\u8FD4\u56DE\u63D0\u793A\uFF0C\u53EF\u4EE5\u7EE7\u7EED\u7528\u540C\u4E00\u4E2A taskId \u7B49\u5F85\u3002",
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
        cwd: { type: "string", description: "delegate\uFF1A\u6210\u5458 B \u4E0A\u7684\u5DE5\u4F5C\u76EE\u5F55\u3002" }
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
            `\u7528 wait_member \u7B49\u5F85\u56DE\u590D\uFF1AtaskId="${task.id}"\uFF0CtimeoutMs=30000\u3002`,
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
      "\u5B8C\u6210\uFF1A\u8FD4\u56DE\u6210\u5458\u5BF9\u8BDD\u7684\u6700\u7EC8\u6587\u672C\u3002",
      "\u8D85\u65F6\uFF1A\u8FD4\u56DE done=false \u548C\u201C\u53EF\u4EE5\u7EE7\u7EED\u8C03\u7528 wait_member\u201D\u7684\u63D0\u793A\uFF1B\u7528\u540C\u4E00\u4E2A taskId \u518D\u8C03\u4E00\u6B21\u5373\u53EF\u3002",
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
      const data = { ...task, done: result.done, timedOut: result.timedOut, logFile: memberTasks.logPath(task.id) };
      if (!result.done) {
        const effective = Math.min(3e5, Math.max(1e3, timeoutMs));
        return {
          ok: true,
          text: [
            `\u6210\u5458\u4EFB\u52A1 ${task.id} \u4ECD\u5728\u8FD0\u884C\uFF1A${task.member}\uFF08${task.memberIp}\uFF09\uFF0C\u5BF9\u8BDD ${task.conversationId}\u3002`,
            `\u53EF\u4EE5\u7EE7\u7EED\u8C03\u7528 wait_member \u7B49\u5F85\uFF1AtaskId="${task.id}"\uFF0CtimeoutMs=${String(effective)}\u3002`,
            typeof task.lastText === "string" && task.lastText !== "" ? `\u6700\u8FD1\u8F93\u51FA\uFF1A${task.lastText.slice(0, 500)}` : "",
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].filter((line) => line !== "").join("\n"),
          data
        };
      }
      if (task.status === "completed") {
        return {
          ok: true,
          text: [
            `\u6210\u5458\u4EFB\u52A1 ${task.id} \u5DF2\u5B8C\u6210\uFF1A${task.member}\uFF08${task.memberIp}\uFF09\u3002`,
            "\u7ED3\u679C\uFF1A",
            typeof task.lastText === "string" && task.lastText !== "" ? task.lastText : "(\u6210\u5458\u6CA1\u6709\u8FD4\u56DE\u6587\u672C\u7ED3\u679C)",
            `\u65E5\u5FD7\uFF1A${data.logFile}`
          ].join("\n"),
          data
        };
      }
      return {
        ok: false,
        text: [
          `\u6210\u5458\u4EFB\u52A1 ${task.id} ${task.status}\uFF1A${task.error ?? "unknown"}`,
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
    lines.push(`\u4EA7\u7269 ${artifact.target}\uFF1A${artifact.archive}\uFF08${formatBytes2(artifact.bytes)}\uFF09`);
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
function formatBytes2(value) {
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

// src/index.ts
var inject = ["webServer"];
function dataDirectory() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path9.join(homedir2(), ".dsh");
  return path9.join(home, "mesh");
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
  registerApi(ctx, service);
  registerWireGuardApi(ctx);
  try {
    ctx.inject(["tools"], (toolsCtx) => {
      registerTools(ctx, toolsCtx, service);
    });
  } catch (error) {
    console.error(`mesh: tools service is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export {
  apply,
  inject
};
