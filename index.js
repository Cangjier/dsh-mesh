// src/index.ts
import { homedir } from "node:os";
import path7 from "node:path";

// src/lib/service.mjs
import { readFile as readFile5, readdir as readdir3 } from "node:fs/promises";
import { readFileSync, existsSync as existsSync3 } from "node:fs";
import os4 from "node:os";
import path5 from "node:path";
import { fileURLToPath } from "node:url";

// code/shared/wireguard.mjs
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
var DEFAULT_MEMBER_PORTS = Object.freeze([80, 8080]);
var MEMBER_SERVICE = "dsh-person-web";
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
  const timeoutMs = options.timeoutMs ?? 800;
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
import { appendFile, mkdir as mkdir2, readFile as readFile3, rename as rename2, rm as rm2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync as existsSync2 } from "node:fs";
import { randomBytes } from "node:crypto";
import os3 from "node:os";
import path3 from "node:path";

// code/build/engine.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, cp, mkdir, open, readFile as readFile2, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import os2 from "node:os";
import path2 from "node:path";
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
  const [os5, arch] = String(target).split("-");
  if (!["linux", "win", "darwin"].includes(os5)) throw new Error(`unsupported target OS: ${target}`);
  if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported target architecture: ${target}`);
  return { os: os5, arch, libc: os5 === "linux" ? "glibc" : "" };
}
function classifySource(source) {
  const value = String(source).trim().replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/\/+$/u, "");
  if (existsSync(value)) return { kind: "local", dir: path2.resolve(value) };
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
  if (existsSync(file) && (await stat(file)).size > 0) return true;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {
  });
  log(`GET ${url}`);
  const response = await fetchImpl(url, { redirect: "follow" });
  if (response.status === 404) return false;
  if (!response.ok || response.body === null) throw new Error(`download failed: ${url} -> HTTP ${String(response.status)}`);
  await mkdir(path2.dirname(file), { recursive: true });
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
    const entries = await readdir(temporary);
    const first = entries[0];
    const wrapped = entries.length === 1 && first !== void 0 && (await stat(path2.join(temporary, first))).isDirectory();
    const content = wrapped ? path2.join(temporary, first) : temporary;
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
  const cacheDir = options.cacheDir ?? path2.join(os2.homedir(), ".dsh", "person-web", "cache");
  const urls = tarballUrls(classified, ref);
  const archive = path2.join(cacheDir, "sources", `${sha256Text(`${classified.owner}/${classified.repo}@${ref}`).slice(0, 16)}.tar.gz`);
  const immutable = /^[0-9a-f]{40}$/iu.test(ref);
  if (!immutable && existsSync(archive)) {
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
  const dir = path2.join(options.workDir, "src");
  log(`extracting ${path2.basename(archive)} to ${dir}`);
  await extractTarball(archive, dir, { log });
  return { dir, source, ref, local: false, archive, archiveSha256 };
}
async function loadRecipes(file) {
  const parsed = JSON.parse(await readFile2(file, "utf8"));
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
      const target = path2.join(options.dir, entry.path);
      const overlay = path2.join(options.overlayRoot, entry.overlay);
      const label = { step: step.id, title: step.title, doc: step.doc, path: entry.path };
      if (!existsSync(overlay)) {
        mismatches.push({ ...label, reason: "overlay file is missing", expected: entry.baseSha256 ?? null, actual: null });
        continue;
      }
      let current = null;
      try {
        current = await readFile2(target, "utf8");
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
      await mkdir(path2.dirname(target), { recursive: true });
      await cp(overlay, target);
      const written = await readFile2(target, "utf8");
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
  const jsonPath = path2.join(options.dir, "work-order.json");
  const markdownPath = path2.join(options.dir, "work-order.md");
  const promptPath = path2.join(options.dir, "subagent-prompt.txt");
  const prompt = [
    `\u4F60\u5728\u4E3A dsh-person-web \u6784\u5EFA ${options.source}@${options.ref} \u7684\u4FEE\u6539\u7248 Web \u5305\u3002`,
    "\u786E\u5B9A\u6027\u6784\u5EFA\u5728\u5E94\u7528\u6E90\u7801\u8986\u76D6\u5C42\u65F6\u5931\u8D25\u3002\u8BF7\u53EA\u4FEE\u590D\u5DE5\u4F5C\u6811\u91CC\u7684\u6E90\u7801\uFF0C\u4E0D\u8981\u653E\u5BBD\u8986\u76D6\u5C42\u6821\u9A8C\u3002",
    "\u5148\u8BFB work-order.md \u4E0E\u5BF9\u5E94\u7684 Step \u6587\u6863\uFF0C\u518D\u4FEE\u6539\u4E0B\u5217\u6587\u4EF6\uFF0C\u4F7F\u6BCF\u4E2A\u6587\u4EF6\u7684\u8986\u76D6\u5C42 marker \u5B58\u5728\uFF0C\u5E76\u8BA9 pnpm run build:web \u901A\u8FC7\u3002",
    `\u4FEE\u5B8C\u540E\u8FD0\u884C \`node code/build/cli.mjs learn --job ${jobDir}\` \u628A\u4FEE\u6539\u6536\u6210\u65B0\u7684\u8986\u76D6\u5C42\uFF0C\u7136\u540E \`node code/build/cli.mjs build --job ${jobDir} --resume\`\u3002`,
    "",
    ...options.result.mismatches.map((item) => `- ${item.path}\uFF08${item.step}\uFF1B${item.doc}\uFF09\uFF1A${item.reason}`)
  ].join("\n");
  const markdown = [
    `# \u6784\u5EFA\u5DE5\u4F5C\u5355\uFF1A${options.source}@${options.ref}`,
    "",
    `- \u6E90\u7801\u6811\uFF1A\`${options.worktree ?? path2.join(jobDir, "src")}\``,
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
    "2. \u4FDD\u6301\u8986\u76D6\u5C42 marker \u6CE8\u91CA\u5B58\u5728\uFF1Apicker \u662F `dsh-person-web overlay: picker`\uFF0Clogin \u662F `dsh-person-web overlay: login`\u3002",
    `3. \u8FD0\u884C \`node code/build/cli.mjs learn --job ${jobDir}\`\uFF1B\u5B83\u4F1A\u628A\u6539\u597D\u7684\u6587\u4EF6\u5199\u56DE \`build/overlays/\`\u3002`,
    `4. \u8FD0\u884C \`node code/build/cli.mjs build --job ${jobDir} --resume\`\uFF1B\u4E0B\u4E00\u6B21\u540C\u4E00 ref \u4F1A\u5148\u5E94\u7528\u8FD9\u4EFD\u65B0\u8986\u76D6\u5C42\u3002`,
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
    worktree: options.worktree ?? path2.join(jobDir, "src"),
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
      const source = path2.join(options.worktree, entry.path);
      let text;
      try {
        text = await readFile2(source, "utf8");
      } catch {
        throw new Error(`cannot learn ${entry.path}: the file is missing from the worktree`);
      }
      if (!text.includes(entry.marker)) {
        throw new Error(`cannot learn ${entry.path}: the overlay marker "${entry.marker}" is missing`);
      }
      const target = path2.join(options.overlayRoot, entry.overlay);
      await mkdir(path2.dirname(target), { recursive: true });
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
    path2.join(options.dir, "apps", "web", "dist"),
    path2.join(options.dir, "dist")
  ];
  for (const candidate of candidates) {
    if (existsSync(path2.join(candidate, "index.html"))) return { ok: true, dist: candidate };
  }
  return { ok: false, dist: null, error: "the build finished but no dist/index.html was found" };
}
async function copyIfExists(from, to) {
  if (!existsSync(from)) return;
  await mkdir(path2.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}
async function listFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path2.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path2.relative(dir, full));
    }
  }
  if (existsSync(dir)) await walk(dir);
  return out;
}
async function assembleWebPackage(options) {
  const { os: targetOs, arch, libc } = parseTarget(options.target);
  const packageDir = path2.join(options.outputDir, `dsh-person-web-${options.version}-${targetOs}-${arch}`);
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(path2.join(packageDir, "web"), { recursive: true });
  await cp(options.dist, path2.join(packageDir, "web"), { recursive: true });
  await copyIfExists(path2.join(options.repositoryRoot, "code", "gate"), path2.join(packageDir, "gate"));
  await copyIfExists(path2.join(options.repositoryRoot, "code", "shared"), path2.join(packageDir, "shared"));
  await copyIfExists(path2.join(options.repositoryRoot, "code", "config"), path2.join(packageDir, "config"));
  await copyIfExists(path2.join(options.repositoryRoot, "code", "windows-service"), path2.join(packageDir, "code", "windows-service"));
  await copyIfExists(path2.join(options.repositoryRoot, "code", "interop-service"), path2.join(packageDir, "code", "interop-service"));
  await copyIfExists(path2.join(options.repositoryRoot, "docs"), path2.join(packageDir, "docs"));
  for (const file of ["install.sh", "start.sh", "stop.sh", "status.sh", "doctor.sh", "install.ps1", "start.ps1", "stop.ps1", "start.cmd", "stop.cmd", "VERSION"]) {
    await copyIfExists(path2.join(options.repositoryRoot, "code", file), path2.join(packageDir, file));
  }
  for (const file of ["start-interop.sh", "install-interop-service.sh", "uninstall-interop-service.sh"]) {
    await copyIfExists(path2.join(options.repositoryRoot, file), path2.join(packageDir, file));
  }
  for (const file of ["index.js", "client.js", "cordis.patch.yml", "package.json"]) {
    await copyIfExists(path2.join(options.repositoryRoot, file), path2.join(packageDir, "plugins", "dsh-person-web", file));
  }
  await copyIfExists(path2.join(options.repositoryRoot, "locale"), path2.join(packageDir, "plugins", "dsh-person-web", "locale"));
  await copyIfExists(path2.join(options.repositoryRoot, "build"), path2.join(packageDir, "plugins", "dsh-person-web", "build"));
  await copyIfExists(path2.join(options.repositoryRoot, "code", "build"), path2.join(packageDir, "plugins", "dsh-person-web", "code", "build"));
  await copyIfExists(path2.join(options.repositoryRoot, "code", "shared"), path2.join(packageDir, "plugins", "dsh-person-web", "code", "shared"));
  const manifest = {
    format: 1,
    name: "dsh-person-web",
    version: options.version,
    target: { os: targetOs, arch, libc },
    builtAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: options.source ?? null,
    ref: options.ref ?? null,
    tree: options.tree ?? null,
    files: (await listFiles(packageDir)).length
  };
  await writeFile(path2.join(packageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { packageDir, manifest };
}
async function fixTarExecutableModes(archive) {
  const raw = gunzipSync(await readFile2(archive));
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
    result = await runCommand("zip", ["-qr", archive, path2.basename(packageDir)], {
      cwd: path2.dirname(packageDir),
      log: options.log
    });
  } else {
    const args = targetOs === "win" ? ["-a", "-c", "-f", archive, "-C", path2.dirname(packageDir), path2.basename(packageDir)] : ["-czf", archive, "-C", path2.dirname(packageDir), path2.basename(packageDir)];
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
  const archive = path2.join(options.cacheDir, "node", archiveName);
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
    if (!existsSync(path2.join(options.destination, "node.exe"))) throw new Error("Node archive did not contain node.exe");
  } else {
    const node = path2.join(options.destination, "bin", "node");
    if (!existsSync(node)) throw new Error("Node archive did not contain bin/node");
    await chmod(node, 493);
  }
  return { directory: options.destination, archive, sha256: actual };
}
async function installAppDependencies(options) {
  const parsed = parseTarget(options.target);
  const log = options.log ?? (() => {
  });
  await mkdir(options.appDir, { recursive: true });
  await writeFile(path2.join(options.appDir, "package.json"), JSON.stringify({
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
  return { appDir: options.appDir, nodeModules: path2.join(options.appDir, "node_modules") };
}
async function overlayFrontend(options) {
  const log = options.log ?? (() => {
  });
  const frontend = path2.join(options.appDir, "node_modules", "@deepseek-ai", "dsh-web-frontend");
  const packageFile = path2.join(frontend, "package.json");
  if (!existsSync(packageFile)) {
    throw new Error(`cannot find @deepseek-ai/dsh-web-frontend under ${options.appDir}`);
  }
  const target = path2.join(frontend, "dist");
  await rm(target, { recursive: true, force: true });
  await cp(options.dist, target, { recursive: true });
  if (!existsSync(path2.join(target, "index.html"))) {
    throw new Error("the built web frontend has no index.html after the copy");
  }
  log(`frontend installed at ${target}`);
  return target;
}
async function patchInstalledClient(options) {
  const log = options.log ?? (() => {
  });
  const picker = path2.join(
    options.appDir,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-directory-picker-browse",
    "lib",
    "client.js"
  );
  const login = path2.join(
    options.appDir,
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-settings-account",
    "lib",
    "client.js"
  );
  for (const file of [picker, login]) {
    if (!existsSync(file)) throw new Error(`installed client bundle is missing: ${file}`);
  }
  const steps = [
    { file: picker, script: path2.join(options.repositoryRoot, "code", "gate", "patch-picker.mjs"), marker: "dsh-picker-patched" },
    { file: login, script: path2.join(options.repositoryRoot, "code", "gate", "patch-login.mjs"), marker: "dsh-gate-account-login" }
  ];
  for (const step of steps) {
    log(`patching ${path2.basename(path2.dirname(path2.dirname(step.file)))} client bundle`);
    const result = await runCommand(process.execPath, [step.script, step.file], {
      cwd: options.repositoryRoot,
      log,
      timeoutMs: 12e4
    });
    if (!result.ok) throw new Error(`client bundle patch failed: ${step.script}
${result.tail.join("\n")}`);
    const text = await readFile2(step.file, "utf8");
    if (!text.includes(step.marker)) throw new Error(`client bundle patch did not leave its marker: ${step.file}`);
    await rm(`${step.file}.orig`, { force: true });
  }
  return { picker, login };
}
async function assembleRuntimePackage(options) {
  const log = options.log ?? (() => {
  });
  const { packageDir, manifest } = await assembleWebPackage(options);
  const appDir = path2.join(packageDir, "app");
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
    destination: path2.join(packageDir, "runtime", "node"),
    fetchImpl: options.fetchImpl,
    log
  });
  for (const file of ["install.ps1", "start.ps1", "stop.ps1", "start.cmd", "stop.cmd"]) {
    await copyIfExists(path2.join(options.repositoryRoot, "code", file), path2.join(packageDir, file));
  }
  await writeFile(path2.join(packageDir, ".offline-payload"), "dsh-person-web\n", "utf8");
  await writeFile(path2.join(packageDir, "VERSION"), `${options.dshVersion}
`, "utf8");
  const updated = {
    ...manifest,
    kind: "offline-runtime",
    dshVersion: options.dshVersion,
    nodeVersion: options.nodeVersion,
    files: (await listFiles(packageDir)).length
  };
  await writeFile(path2.join(packageDir, "manifest.json"), JSON.stringify(updated, null, 2), "utf8");
  return { packageDir, manifest: updated };
}

// code/build/job.mjs
function defaultJobRoot() {
  return path3.join(os3.homedir(), ".dsh", "person-web", "build");
}
function defaultCacheDir() {
  return path3.join(os3.homedir(), ".dsh", "person-web", "cache");
}
async function createJob(options = {}) {
  const root = options.root ?? defaultJobRoot();
  const id = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`;
  const dir = path3.join(root, id);
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
  return JSON.parse(await readFile3(path3.join(dir, "state.json"), "utf8"));
}
async function writeState(dir, state) {
  const file = path3.join(dir, "state.json");
  const temporary = `${file}.tmp`;
  await writeFile2(temporary, JSON.stringify({ ...state, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), "utf8");
  await rename2(temporary, file);
}
async function appendLog(dir, line) {
  await appendFile(path3.join(dir, "build.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, "utf8");
}
async function readLogTail(dir, lines = 80) {
  try {
    const text = await readFile3(path3.join(dir, "build.log"), "utf8");
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
  const recipesPath = options.recipesPath ?? path3.join(repositoryRoot, "build", "recipes.json");
  const overlayRoot = options.overlayRoot ?? path3.join(repositoryRoot, "build", "overlays");
  let state = await readState(dir);
  const log = (line) => {
    void appendLog(dir, line);
  };
  try {
    state = await updateState(dir, { status: "running", phase: "prepare", error: null });
    const prepared = options.reuseWorktree === true && existsSync2(path3.join(dir, "src")) ? { dir: path3.join(dir, "src"), source: state.source, ref: state.ref, local: false, archiveSha256: state.archiveSha256 ?? null } : await prepareSource({
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
        dir: path3.join(dir, "work-order"),
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
        outputDir: path3.join(dir, "dist"),
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
  const recipesPath = options.recipesPath ?? path3.join(options.repositoryRoot, "build", "recipes.json");
  const overlayRoot = options.overlayRoot ?? path3.join(options.repositoryRoot, "build", "overlays");
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
    path3.join(worktree, "apps", "cli", "package.json"),
    path3.join(worktree, "package.json")
  ]) {
    try {
      const pkg = JSON.parse(await readFile3(candidate, "utf8"));
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
import { mkdir as mkdir3, readFile as readFile4, readdir as readdir2, stat as stat3, writeFile as writeFile3 } from "node:fs/promises";
import path4 from "node:path";
var DEFAULT_APP_ROOT = {
  linux: "/opt/dsh-person-web",
  windows: "C:\\dsh-person-web"
};
var DEFAULT_SERVICES = {
  linux: [
    { name: "dsh-web-app.service", role: "dsh", command: "start-dsh.sh" },
    { name: "dsh-web-gate.service", role: "gate", command: "start.sh" }
  ],
  windows: [
    { name: "DSH-Web-App", role: "dsh", command: "dsh-web-app-service.exe" },
    { name: "DSH-Person-Web", role: "gate", command: "dsh-person-web-service.exe" }
  ]
};
var ROLE_ORDER = { control: 0, dsh: 1, gate: 2 };
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
function ps(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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
function normalizeServices(input, os5) {
  const source = input === void 0 ? DEFAULT_SERVICES[os5] : input;
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
    const command = typeof raw.command === "string" && raw.command.trim() !== "" ? raw.command.trim() : os5 === "linux" ? "start.sh" : "dsh-person-web-service.exe";
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
async function findLatestPackage(repositoryRoot, os5) {
  const dist = path4.join(repositoryRoot, "dist");
  const suffix = os5 === "linux" ? ".tar.gz" : ".zip";
  const prefix = `dsh-person-web-`;
  const marker = `-${os5 === "linux" ? "linux" : "win"}-x64`;
  const entries = await readdir2(dist).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix) || !entry.includes(marker)) continue;
    const file = path4.join(dist, entry);
    const info = await stat3(file).catch(() => null);
    if (info?.isFile()) candidates.push({ file, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`no ${os5} package found in ${dist}; build one or pass --package`);
  }
  return candidates[0].file;
}
async function buildDeployPlan(options) {
  if (typeof options.host !== "string" || options.host.trim() === "") throw new Error("host is required");
  const os5 = normalizeOs(options.os ?? "linux");
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  let packagePath = "";
  let packageInfo = null;
  let sha256 = "";
  if (options.skipPackage !== true) {
    packagePath = options.package ? path4.resolve(options.package) : await findLatestPackage(repositoryRoot, os5);
    packageInfo = await stat3(packagePath);
    if (!packageInfo.isFile()) throw new Error(`package is not a file: ${packagePath}`);
    sha256 = await hashFile(packagePath);
  }
  const release = options.skipPackage === true ? "rollback" : typeof options.release === "string" && options.release.trim() !== "" ? options.release.trim() : `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${sha256.slice(0, 8)}`;
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(release)) {
    throw new Error("release must be 3-80 chars of letters, digits, dot, underscore or dash");
  }
  const appRoot = typeof options.appRoot === "string" && options.appRoot.trim() !== "" ? options.appRoot.trim() : DEFAULT_APP_ROOT[os5];
  const services = normalizeServices(options.services, os5);
  const scope = options.scope === "dsh" ? "dsh" : "all";
  const gatePort = String(options.gatePort ?? "80");
  if (!/^\d{1,5}$/.test(gatePort) || Number(gatePort) > 65535) throw new Error("gatePort is invalid");
  const retention = Number.isSafeInteger(options.retention) ? options.retention : 3;
  if (retention < 2) throw new Error("retention must be at least 2 (current plus previous)");
  return {
    host: options.host.trim(),
    user: typeof options.user === "string" && options.user.trim() !== "" ? options.user.trim() : void 0,
    port: Number.isSafeInteger(options.port) ? options.port : 22,
    identityFile: typeof options.identityFile === "string" && options.identityFile.trim() !== "" ? path4.resolve(options.identityFile) : void 0,
    os: os5,
    package: { path: packagePath, bytes: packageInfo?.size ?? 0, sha256 },
    release,
    appRoot,
    shared: `${appRoot}${os5 === "linux" ? "/shared" : "\\shared"}`,
    current: `${appRoot}${os5 === "linux" ? "/current" : "\\current"}`,
    previous: `${appRoot}${os5 === "linux" ? "/previous" : "\\previous"}`,
    releases: `${appRoot}${os5 === "linux" ? "/releases" : "\\releases"}`,
    services,
    scope,
    gatePort,
    retention,
    sudo: options.sudo !== false,
    remotePackage: os5 === "linux" ? `/tmp/dsh-person-web-${release}${path4.extname(packagePath)}` : `C:\\Windows\\Temp\\dsh-person-web-${release}${path4.extname(packagePath)}`
  };
}
function buildLinuxPrepareScript(plan) {
  const serviceBlocks = plan.services.map((service) => {
    const unit = sh(service.name);
    const command = service.command.startsWith("/") ? service.command : `${plan.appRoot}/current/${service.command}`;
    return `write_unit ${unit} ${sh(command)}`;
  }).join("\n");
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
tar -xzf "$PACKAGE" -C "$NEW" --strip-components=1

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

ENV_FILE="$SHARED/config/gate.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE; install this member once before the first SSH deploy" >&2
  exit 1
fi
sed -i "s|^DSH_HOME=.*|DSH_HOME=$SHARED/home|" "$ENV_FILE"
sed -i "s|^DSH_WORKDIR=.*|DSH_WORKDIR=$SHARED/workspace|" "$ENV_FILE"
grep -q '^DSH_HOME=' "$ENV_FILE" || echo "DSH_HOME=$SHARED/home" >> "$ENV_FILE"
grep -q '^DSH_WORKDIR=' "$ENV_FILE" || echo "DSH_WORKDIR=$SHARED/workspace" >> "$ENV_FILE"

test -x "$NEW/runtime/node/node"
"$NEW/runtime/node/node" --check "$NEW/gate/server.mjs"
test -f "$NEW/manifest.json"

write_unit() {
  local unit="$1"
  local command="$2"
  local dropin="/etc/systemd/system/$unit.d"
  mkdir -p "$dropin"
  cat > "$dropin/dsh-release.conf" <<EOF
[Service]
WorkingDirectory=$APP_ROOT/current
ExecStart=$command
EOF
}
${serviceBlocks}
systemctl daemon-reload
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
if ! health; then
  echo "health check failed on $RELEASE; rolling back" >&2
  if [ -n "$OLD" ]; then
    ln -sfn "$OLD" "$CURRENT"
${rollbackRestart.split("\n").map((line) => `    ${line}`).join("\n")}
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
echo "rolled back to $OLD"
`;
}
function buildWindowsPrepareScript(plan) {
  const serviceLines = plan.services.map((service) => {
    const command = service.command;
    return `$exe = Join-Path $New ${ps(command)}
if (-not (Test-Path $exe)) {
  $oldExe = Join-Path $Current ${ps(command)}
  if (Test-Path $oldExe) { Copy-Item $oldExe $exe -Force } else { throw "missing service binary: $exe" }
}
$binPath = $AppRoot + '\\current\\' + ${ps(command)}
& sc.exe config ${ps(service.name)} binPath= $binPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc config failed for ${service.name}" }`;
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
if (Test-Path $New) { throw "release already exists: $New" }
New-Item -ItemType Directory -Force -Path $New | Out-Null
Expand-Archive -LiteralPath $Package -DestinationPath $New -Force
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
if (-not (Test-Path $envFile)) { throw "missing $envFile; install this member once before the first SSH deploy" }
$text = Get-Content -LiteralPath $envFile -Raw
$text = [regex]::Replace($text, '(?m)^DSH_HOME=.*$', "DSH_HOME=$Shared\\home")
$text = [regex]::Replace($text, '(?m)^DSH_WORKDIR=.*$', "DSH_WORKDIR=$Shared\\workspace")
if ($text -notmatch '(?m)^DSH_HOME=') { $text += "\`r\`nDSH_HOME=$Shared\\home" }
if ($text -notmatch '(?m)^DSH_WORKDIR=') { $text += "\`r\`nDSH_WORKDIR=$Shared\\workspace" }
Set-Content -LiteralPath $envFile -Value $text -Encoding utf8 -NoNewline
$node = Join-Path $New 'runtime\\node\\node.exe'
if (-not (Test-Path $node)) { throw "missing $node" }
& $node --check (Join-Path $New 'gate\\server.mjs')
if ($LASTEXITCODE -ne 0) { throw 'gate syntax check failed' }
${serviceLines}
Write-Output "prepared $Release at $New"
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
      `upload ${path4.basename(plan.package.path)} to ${plan.remotePackage}`,
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
   * Upload a local file with scp.
   * @param {string} local local path.
   * @param {string} remote remote path.
   * @returns {Promise<void>}
   */
  async upload(local, remote) {
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-P", String(this.plan.port)];
    if (this.plan.identityFile) args.push("-i", this.plan.identityFile);
    args.push(local, `${this.target()}:${remote}`);
    await this.runProcess("scp", args);
  }
  /**
   * Run a local process and reject on a non-zero exit.
   * @param {string} command command.
   * @param {string[]} args arguments.
   * @param {string} [input] stdin.
   * @returns {Promise<{stdout:string,stderr:string}>} output.
   */
  runProcess(command, args, input) {
    return new Promise((resolve, reject) => {
      const child = spawn2(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => {
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
  async script(script, os5) {
    const base = this.sshOptions();
    if (os5 === "linux") {
      const remote = this.plan.sudo ? "sudo -n bash -s" : "bash -s";
      await this.runProcess("ssh", [...base, this.target(), remote], script);
      return;
    }
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    await this.runProcess("ssh", [...base, this.target(), `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`]);
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
  }
  /** @returns {Promise<void>} no owned process. */
  async dispose() {
  }
  /**
   * Plan only; no network.
   * @param {object} request deploy options.
   * @returns {Promise<object>} plan summary.
   */
  async plan(request) {
    const plan = await buildDeployPlan({ ...request, repositoryRoot: this.repositoryRoot });
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
    const plan = await buildDeployPlan({ ...request, repositoryRoot: this.repositoryRoot });
    const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path4.join(this.dataDir, id);
    await mkdir3(dir, { recursive: true });
    const stateFile = path4.join(dir, "job.json");
    const logFile = path4.join(dir, "deploy.log");
    const state = {
      id,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      target: { host: plan.host, user: plan.user ?? null, port: plan.port, os: plan.os, appRoot: plan.appRoot },
      release: plan.release,
      package: plan.package.path,
      services: plan.services.map((service) => service.name),
      status: "running",
      phase: "starting",
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
    const task = this.#run(plan, state, stateFile, log);
    this.running.set(id, task);
    task.finally(() => this.running.delete(id)).catch(() => {
    });
    return { ok: true, job: state };
  }
  async #run(plan, state, stateFile, log) {
    try {
      const runner = this.runnerFactory(plan);
      await log(`target ${plan.host} (${plan.os}), release ${plan.release}`);
      await log(`package ${plan.package.path} (${plan.package.sha256.slice(0, 12)}\u2026)`);
      await log(`uploading to ${plan.remotePackage}`);
      await runner.upload(plan.package.path, plan.remotePackage);
      const scripts = this.scripts(plan);
      state.phase = "prepare";
      await this.#save(stateFile, state);
      await log("prepare: extract, shared dirs, service definitions (no switch)");
      await runner.script(scripts.prepare, plan.os);
      state.phase = "activate";
      await this.#save(stateFile, state);
      await log("activate: switch current, restart services with the gateway last");
      await runner.script(scripts.activate, plan.os);
      state.status = "succeeded";
      state.phase = "done";
      await this.#save(stateFile, state);
      await log("deployment succeeded");
    } catch (error) {
      state.status = "failed";
      state.phase = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      await this.#save(stateFile, state).catch(() => {
      });
      await log(`deployment failed: ${state.error}`).catch(() => {
      });
    }
  }
  async #save(stateFile, state) {
    await writeFile3(stateFile, `${JSON.stringify(state, null, 2)}
`, "utf8");
  }
  /**
   * Read a job.
   * @param {string} id job id.
   * @returns {Promise<object|null>} state.
   */
  async status(id) {
    if (typeof id !== "string" || !/^deploy-[A-Za-z0-9-]+$/.test(id)) return null;
    try {
      return JSON.parse(await readFile4(path4.join(this.dataDir, id, "job.json"), "utf8"));
    } catch {
      return null;
    }
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
      const text = await readFile4(path4.join(this.dataDir, id, "deploy.log"), "utf8");
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
    const dir = path4.join(this.dataDir, id);
    await mkdir3(dir, { recursive: true });
    const stateFile = path4.join(dir, "job.json");
    const logFile = path4.join(dir, "deploy.log");
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
        state.error = error instanceof Error ? error.message : String(error);
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

// src/lib/service.mjs
var HERE = path5.dirname(fileURLToPath(import.meta.url));
function findRepositoryRoot(start) {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync3(path5.join(current, "build", "recipes.json")) && existsSync3(path5.join(current, "code", "build"))) {
      return current;
    }
    const parent = path5.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path5.resolve(start, "..", "..");
}
var REPOSITORY_ROOT = findRepositoryRoot(HERE);
function packageVersion() {
  try {
    const parsed = JSON.parse(readFileSync(path5.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
var PersonWebService = class {
  /**
   * @param {{dataDir: string, config?: object, log?: (line: string) => void}} options service input.
   */
  constructor(options) {
    this.dataDir = options.dataDir;
    this.config = options.config ?? {};
    this.logLine = options.log ?? (() => {
    });
    this.jobRoot = path5.join(this.dataDir, "build");
    this.cacheDir = path5.join(this.dataDir, "cache");
    this.version = packageVersion();
    this.repositoryRoot = REPOSITORY_ROOT;
    this.recipesPath = path5.join(REPOSITORY_ROOT, "build", "recipes.json");
    this.overlayRoot = path5.join(REPOSITORY_ROOT, "build", "overlays");
    this.home = path5.dirname(this.dataDir);
    this.deployRoot = path5.join(this.dataDir, "deploy");
    this.deploy = new DeployManager({
      repositoryRoot: REPOSITORY_ROOT,
      dataDir: this.deployRoot,
      log: (line) => this.logLine(`deploy: ${line}`)
    });
    this.running = /* @__PURE__ */ new Map();
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
    const stateFile = path5.join(this.home, "wireguard", "state.json");
    const { state, error } = await readWireGuardState({ file: stateFile });
    const identity = state === null ? null : wireGuardIdentity(state);
    return {
      ok: true,
      host: {
        hostname: os4.hostname(),
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
  async members() {
    const stateFile = path5.join(this.home, "wireguard", "state.json");
    const { state, error } = await readWireGuardState({ file: stateFile });
    const identity = state === null ? null : wireGuardIdentity(state);
    const self = {
      id: "local",
      kind: "self",
      name: identity?.selfName ?? os4.hostname(),
      ip: identity?.selfIp ?? "",
      online: true,
      dsh: true,
      port: null,
      latencyMs: 0,
      gate: null,
      error: null
    };
    const snapshot = await discoverMembers({
      state,
      stateError: error,
      self,
      ports: Array.isArray(this.config.memberPorts) ? this.config.memberPorts : [80, 8080]
    });
    return { ...snapshot, local: snapshot.self };
  }
  /**
   * Start one build job in the background.
   * @param {{source?: string, ref?: string, targets?: string[], planOnly?: boolean, version?: string}} request build request.
   * @returns {Promise<object>} the initial job state.
   */
  async startBuild(request = {}) {
    const defaults = await this.status();
    const source = (typeof request.source === "string" && request.source !== "" ? request.source : defaults.build.source) || DEFAULT_SOURCE;
    const ref = (typeof request.ref === "string" && request.ref !== "" ? request.ref : defaults.build.ref) || DEFAULT_REF;
    const targets = Array.isArray(request.targets) && request.targets.length > 0 ? request.targets : defaults.build.targets;
    const job = await createJob({ root: this.jobRoot, source, ref, targets });
    this.logLine(`person-web build job ${job.id} created`);
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
      this.logLine(`person-web build job ${job.id} crashed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.running.delete(job.id);
    });
    this.running.set(job.id, promise);
    return { ...job.state, dir: job.dir, running: true };
  }
  /**
   * Continue a job from its corrected worktree. This is what follows
   * `build_learn`: the overlays have been updated, and the worktree already
   * contains the fix, so nothing is downloaded again.
   * @param {string} id job id.
   * @returns {Promise<object>} the job state, running in the background.
   */
  async resumeBuild(id) {
    const dir = this._jobDir(id);
    if (this.running.has(id)) throw new Error("this job is already running");
    const state = await readState(dir);
    this.logLine(`person-web build job ${id} resumed`);
    const promise = runJob(dir, {
      repositoryRoot: this.repositoryRoot,
      recipesPath: this.recipesPath,
      overlayRoot: this.overlayRoot,
      cacheDir: this.cacheDir,
      reuseWorktree: true,
      full: this.config.build?.full !== false,
      nodeVersion: typeof this.config.build?.nodeVersion === "string" && this.config.build.nodeVersion !== "" ? this.config.build.nodeVersion : void 0
    }).catch((error) => {
      this.logLine(`person-web build job ${id} crashed: ${error instanceof Error ? error.message : String(error)}`);
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
    if (!existsSync3(this.jobRoot)) return [];
    const entries = await readdir3(this.jobRoot, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const state = await readState(path5.join(this.jobRoot, entry.name));
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
    const parsed = JSON.parse(await readFile5(this.recipesPath, "utf8"));
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
    const dir = path5.resolve(this.jobRoot, id);
    if (!dir.startsWith(`${path5.resolve(this.jobRoot)}${path5.sep}`)) throw new Error("invalid job id");
    return dir;
  }
};

// src/lib/http-api.mjs
var API_PREFIX = "/api/dsh-person-web";
var AGENT_HEADER = "x-dsh-person-web";
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
        const path8 = url.pathname.slice(API_PREFIX.length) || "/";
        if (method === "GET" && path8 === "/status") {
          writeJson(response, 200, await service.status());
          return;
        }
        if (method === "GET" && path8 === "/members") {
          writeJson(response, 200, await service.members());
          return;
        }
        if (method === "GET" && path8 === "/jobs") {
          writeJson(response, 200, { ok: true, jobs: await service.jobs() });
          return;
        }
        if (method === "GET") {
          const read = /^\/build\/([^/]+)(\/log)?$/u.exec(path8);
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
        if (path8 === "/build") {
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
        const resume = /^\/build\/([^/]+)\/resume$/u.exec(path8);
        if (resume !== null) {
          writeJson(response, 202, { ok: true, job: await service.resumeBuild(resume[1]) });
          return;
        }
        const match = /^\/build\/([^/]+)\/learn$/u.exec(path8);
        if (match !== null) {
          writeJson(response, 200, { ok: true, job: await service.learn(match[1]) });
          return;
        }
        writeJson(response, 404, { ok: false, error: { code: "not_found", message: "Unknown person-web endpoint." } });
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
  }), "person-web local api");
}

// src/lib/member-tasks.mjs
import { randomUUID } from "node:crypto";
import { mkdir as mkdir4, readFile as readFile6, readdir as readdir4, rename as rename3, writeFile as writeFile4 } from "node:fs/promises";
import { existsSync as existsSync4, readFileSync as readFileSync2 } from "node:fs";
import path6 from "node:path";
var DEFAULT_INTEROP_PORT = 8765;
var WAIT_TIMEOUT_MS = 6e4;
var MAX_ATTEMPTS = 30;
function envFile(file) {
  const values = {};
  if (!existsSync4(file)) return values;
  for (const raw of readFileSync2(file, "utf8").split(/\r?\n/)) {
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
    this.taskRoot = path6.join(this.dataDir, "member-tasks");
    this.tasks = /* @__PURE__ */ new Map();
    this.monitors = /* @__PURE__ */ new Map();
    this.loaded = false;
    this.disposed = false;
  }
  async dispose() {
    this.disposed = true;
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
    await mkdir4(this.taskRoot, { recursive: true });
    let files = [];
    try {
      files = await readdir4(this.taskRoot);
    } catch {
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const task = JSON.parse(await readFile6(path6.join(this.taskRoot, file), "utf8"));
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
    const file = path6.join(this.taskRoot, `${task.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await mkdir4(this.taskRoot, { recursive: true });
    await writeFile4(temporary, `${JSON.stringify(task, null, 2)}
`, "utf8");
    await rename3(temporary, file);
  }
  async #log(task, line) {
    const text = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}
`;
    try {
      await writeFile4(path6.join(this.taskRoot, `${task.id}.log`), text, { encoding: "utf8", flag: "a" });
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
        path6.join(this.service.repositoryRoot, "..", "config", "gate.env"),
        path6.join(this.service.repositoryRoot, "config", "gate.env"),
        path6.join(this.service.dataDir, "..", "..", "config", "gate.env")
      ];
      for (const file of candidates) {
        const password = envFile(file).DSH_GATE_PASSWORD;
        if (typeof password === "string" && password !== "") return password;
      }
    }
    throw new Error("no interop token: set interopToken, DSH_INTEROP_TOKEN, or DSH_GATE_PASSWORD");
  }
  async #resolveMember(input) {
    const raw = String(input ?? "").trim();
    if (raw === "") throw new Error("member is required");
    if (/^https?:\/\//i.test(raw)) {
      return { name: raw, ip: raw, baseUrl: raw.replace(/\/+$/, "") };
    }
    const snapshot = await this.service.members();
    const all = [snapshot.local, ...Array.isArray(snapshot.members) ? snapshot.members : []].filter(Boolean);
    const match = all.find((member2) => String(member2.id) === raw || String(member2.name) === raw || String(member2.ip) === raw);
    const member = match ?? { id: raw, name: raw, ip: raw };
    let host = String(member.ip ?? member.id ?? raw);
    if (/^https?:\/\//i.test(host)) return { name: member.name ?? raw, ip: host, baseUrl: host.replace(/\/+$/, "") };
    if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
    const port = this.#port();
    return {
      name: member.name ?? member.id ?? raw,
      ip: String(member.ip ?? member.id ?? raw),
      baseUrl: `http://${host}:${String(port)}`
    };
  }
  async #request(baseUrl, method, endpoint, body, timeoutMs = 3e4) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.max(1e3, timeoutMs));
    timer.unref?.();
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
  async start({ member, prompt, cwd, agent, notify = true }) {
    await this.#ensureLoaded();
    if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("prompt is required");
    if (agent === void 0 || agent === null) throw new Error("delegation must be called from a DSH conversation");
    const target = await this.#resolveMember(member);
    const payload = { prompt, ...typeof cwd === "string" && cwd !== "" ? { cwd } : {} };
    const created = await this.#request(target.baseUrl, "POST", "/v1/conversations", payload, 6e4);
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
      attempts: 0,
      turns: 0,
      notify,
      notified: false,
      notifiedAt: null,
      notifyError: null,
      originAgentId: String(agent.id ?? ""),
      originSessionId: String(agent.session?.id ?? "")
    };
    this.tasks.set(task.id, task);
    await this.#save(task);
    await this.#log(task, `created ${conversation.id} on ${target.baseUrl}`);
    const monitor = this.#monitor(task);
    this.monitors.set(task.id, monitor);
    void monitor.finally(() => this.monitors.delete(task.id)).catch(() => {
    });
    return task;
  }
  async run(options) {
    const task = await this.start({ ...options, notify: false });
    await this.monitors.get(task.id);
    return this.tasks.get(task.id) ?? task;
  }
  async send(taskId, content) {
    await this.#ensureLoaded();
    const task = this.tasks.get(String(taskId));
    if (task === void 0) throw new Error("member task not found");
    if (typeof content !== "string" || content.trim() === "") throw new Error("content is required");
    const result = await this.#request(task.baseUrl, "POST", `/v1/conversations/${encodeURIComponent(task.conversationId)}/messages`, { content }, 3e4);
    task.status = "running";
    task.error = null;
    task.notified = false;
    task.notifiedAt = null;
    task.notifyError = null;
    task.notify = true;
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
  async #monitor(task) {
    while (!this.disposed && (task.status === "running" || task.status === "starting")) {
      task.attempts += 1;
      try {
        const result = await this.#request(
          task.baseUrl,
          "POST",
          `/v1/conversations/${encodeURIComponent(task.conversationId)}/wait`,
          { timeoutMs: WAIT_TIMEOUT_MS },
          WAIT_TIMEOUT_MS + 1e4
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
        task.status = conversation.status === "idle" ? conversation.error ? "failed" : "completed" : "running";
        if (task.status === "completed" || task.status === "failed") break;
      } catch (error) {
        task.error = error instanceof Error ? error.message : String(error);
        await this.#log(task, `wait failed: ${task.error}`);
        if (task.attempts >= MAX_ATTEMPTS) {
          task.status = "failed";
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(2e3 * task.attempts, 15e3)));
      }
    }
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
      const text = await readFile6(path6.join(this.taskRoot, `${task.id}.log`), "utf8");
      return text.split("\n").slice(-Math.max(1, Math.min(lines, 500))).join("\n");
    } catch {
      return "";
    }
  }
};

// src/lib/tools.mjs
function registerTools(ctx, toolsCtx, service) {
  const definition = {
    name: "dsh_person_web",
    description: [
      "\u7BA1\u7406\u4E2A\u4EBA\u7248 DSH Web \u7684\u6210\u5458\u4E0E\u6784\u5EFA\u3002",
      "",
      "\u6210\u5458\uFF1A`members` \u8BFB\u53D6 WireGuard \u6210\u5458\u5E76\u63A2\u6D4B\u6BCF\u4E2A\u6210\u5458\u7684 DSH \u7F51\u5173\uFF1B`status` \u8BFB\u53D6\u672C\u673A\u4E0E WireGuard \u72B6\u6001\u3002",
      "\u6784\u5EFA\uFF1A`build` \u4ECE\u56FA\u5B9A GitHub \u6E90\u7801\uFF08\u9ED8\u8BA4 master\uFF09clone \u4E00\u4EFD\u5DE5\u4F5C\u6811\uFF0C\u5E94\u7528\u6E90\u7801\u8986\u76D6\u5C42\uFF0C\u6784\u5EFA Web \u524D\u7AEF\uFF0C\u5E76\u6309 linux-x64/win-x64 \u6253\u5305\u3002\u5DE5\u5177\u7ACB\u5373\u8FD4\u56DE job id\uFF1B\u7528 `build_status` \u770B\u8FDB\u5EA6\uFF0C`build_logs` \u770B\u65E5\u5FD7\u3002",
      "\u5982\u679C\u8986\u76D6\u5C42\u4E0E\u4E0A\u6E38\u6E90\u7801\u4E0D\u518D\u5339\u914D\uFF0C\u6784\u5EFA\u8FD4\u56DE needs-fix \u5DE5\u4F5C\u5355\uFF1B\u628A\u5DE5\u4F5C\u5355\u4EA4\u7ED9 subagent \u4FEE\u597D\u5DE5\u4F5C\u6811\u540E\uFF0C\u8C03\u7528 `build_learn` \u628A\u4FEE\u6539\u6536\u6210\u65B0\u7684\u8986\u76D6\u5C42\uFF0C\u518D\u7528\u540C\u4E00\u4E2A job `build` \u7EE7\u7EED\u3002",
      "`recipes` \u5217\u51FA\u5F53\u524D\u8986\u76D6\u5C42\u548C\u5B83\u4EEC\u5BF9\u5E94\u7684 Step \u6587\u6863\u3002",
      "",
      "\u6CE8\u610F\uFF1A\u6784\u5EFA\u4F1A\u8FD0\u884C pnpm install \u4E0E\u6E90\u7801\u4ED3\u5E93\u7684 build \u811A\u672C\uFF0C\u8017\u65F6\u6570\u5206\u949F\u5E76\u5360\u7528\u78C1\u76D8\uFF1B\u53EA\u5BF9\u53EF\u4FE1\u6E90\u7801\u4F7F\u7528\uFF0C\u4E00\u6B21\u53EA\u8DD1\u4E00\u4E2A\u6784\u5EFA\u66F4\u7A33\u59A5\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "members", "jobs", "build", "build_status", "build_logs", "build_learn", "build_resume", "recipes"],
          description: "\u8981\u6267\u884C\u7684\u52A8\u4F5C\u3002"
        },
        source: {
          type: "string",
          description: "build\uFF1A\u6E90\u7801 URL \u6216\u672C\u5730\u76EE\u5F55\u3002\u7701\u7565\u65F6\u7528\u914D\u7F6E/recipes \u7684\u56FA\u5B9A\u6E90\u3002"
        },
        ref: {
          type: "string",
          description: "build\uFF1A\u5206\u652F\u3001tag \u6216 commit\u3002\u7701\u7565\u65F6\u7528 master\u3002"
        },
        targets: {
          type: "array",
          items: { type: "string" },
          description: 'build\uFF1A\u76EE\u6807\u5217\u8868\uFF0C\u4F8B\u5982 ["linux-x64","win-x64"]\u3002\u7701\u7565\u65F6\u7528\u914D\u7F6E\u3002'
        },
        planOnly: {
          type: "boolean",
          description: "build\uFF1A\u53EA\u5E94\u7528\u8986\u76D6\u5C42\u5E76\u5199\u5DE5\u4F5C\u5355\uFF0C\u4E0D\u8FD0\u884C pnpm install/build\u3002"
        },
        version: {
          type: "string",
          description: "build\uFF1A\u8986\u76D6\u5305\u7248\u672C\u53F7\u3002"
        },
        jobId: {
          type: "string",
          description: "build_status / build_logs / build_learn\uFF1A\u4EFB\u52A1 id\u3002"
        },
        lines: {
          type: "number",
          description: "build_logs\uFF1A\u8FD4\u56DE\u6700\u540E\u591A\u5C11\u884C\uFF0C\u9ED8\u8BA4 80\u3002"
        }
      },
      required: ["action"],
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
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action);
      if (action === "status") {
        const data = await service.status();
        return { ok: true, text: formatStatus(data), data };
      }
      if (action === "members") {
        const data = await service.members();
        return { ok: true, text: formatMembers(data), data };
      }
      if (action === "jobs") {
        const jobs = await service.jobs();
        return { ok: true, text: jobs.length === 0 ? "\u8FD8\u6CA1\u6709\u6784\u5EFA\u4EFB\u52A1\u3002" : jobs.map((job) => `${job.id}  ${job.status}  ${job.phase}  ${job.ref}`).join("\n"), data: { jobs } };
      }
      if (action === "recipes") {
        const data = await service.recipes();
        return {
          ok: true,
          text: [
            `\u6E90\u7801\uFF1A${data.source}@${data.ref}`,
            `tree\uFF1A${data.tree ?? "\u2014"}`,
            ...data.steps.map((step) => `- ${step.id}\uFF08${step.title}\uFF09\uFF1A${step.files.map((file) => file.path).join(", ")}\uFF1B\u6587\u6863\uFF1A${step.doc}`)
          ].join("\n"),
          data
        };
      }
      if (action === "build") {
        const job = await service.startBuild({
          source: typeof args.source === "string" ? args.source : void 0,
          ref: typeof args.ref === "string" ? args.ref : void 0,
          targets: Array.isArray(args.targets) ? args.targets : void 0,
          planOnly: args.planOnly === true,
          version: typeof args.version === "string" ? args.version : void 0
        });
        return {
          ok: true,
          text: [
            `\u5DF2\u542F\u52A8\u6784\u5EFA\u4EFB\u52A1 ${job.id}\uFF08${job.source}@${job.ref} -> ${job.targets.join(", ")}\uFF09\u3002`,
            "\u7528 build_status \u67E5\u770B\u8FDB\u5EA6\uFF0Cbuild_logs \u67E5\u770B\u65E5\u5FD7\u3002",
            `\u4EFB\u52A1\u76EE\u5F55\uFF1A${job.dir}`
          ].join("\n"),
          data: job
        };
      }
      if (action === "build_status") {
        const job = await service.job(requireJobId(args));
        return {
          ok: true,
          text: [
            `${job.id}  ${job.status}  ${job.phase}`,
            `\u6E90\u7801\uFF1A${job.source}@${job.ref}`,
            job.error ? `\u9519\u8BEF\uFF1A${job.error}` : "",
            job.workOrderMarkdown ? `\u5DE5\u4F5C\u5355\uFF1A${job.workOrderMarkdown}` : "",
            job.running ? "\u4EFB\u52A1\u4ECD\u5728\u8FD0\u884C\u3002" : "\u4EFB\u52A1\u5DF2\u505C\u6B62\u3002"
          ].filter(Boolean).join("\n"),
          data: job
        };
      }
      if (action === "build_logs") {
        const jobId = requireJobId(args);
        const lines = await service.log(jobId, typeof args.lines === "number" ? args.lines : 80);
        return { ok: true, text: lines.join("\n"), data: { jobId, lines } };
      }
      if (action === "build_learn") {
        const job = await service.learn(requireJobId(args));
        return {
          ok: true,
          text: `\u5DF2\u628A\u5DE5\u4F5C\u6811\u91CC\u7684\u4FEE\u6539\u6536\u6210\u8986\u76D6\u5C42\uFF1B\u73B0\u5728\u53EF\u4EE5\u7528 build_resume \u7EE7\u7EED\u540C\u4E00\u4E2A\u4EFB\u52A1\u3002
${job.worktree ?? ""}`,
          data: job
        };
      }
      if (action === "build_resume") {
        const job = await service.resumeBuild(requireJobId(args));
        return {
          ok: true,
          text: `\u5DF2\u7EE7\u7EED\u4EFB\u52A1 ${job.id}\uFF0C\u590D\u7528\u73B0\u6709\u5DE5\u4F5C\u6811\uFF1B\u7528 build_status \u67E5\u770B\u8FDB\u5EA6\u3002`,
          data: job
        };
      }
      throw new Error(`unknown action: ${action}`);
    }
  };
  const deployDefinition = {
    name: "dsh_person_deploy",
    description: [
      "\u901A\u8FC7 SSH \u84DD\u7EFF\u90E8\u7F72 dsh-person-web \u6210\u5458\u3002",
      "",
      "`plan` \u53EA\u8BA1\u7B97\u53D1\u5E03\u8BA1\u5212\uFF0C\u4E0D\u8054\u7F51\uFF1B`deploy` \u4E0A\u4F20\u5305\u5230\u76EE\u6807\uFF0C\u5148\u89E3\u538B\u5230\u65B0\u7684 releases/<release> \u76EE\u5F55\u5E76\u51C6\u5907\u597D\u5171\u4EAB config/data/home/workspace \u4E0E\u670D\u52A1\u5B9A\u4E49\uFF0C\u786E\u8BA4\u5168\u90E8\u5C31\u7EEA\u540E\u624D\u5207\u6362 current\uFF1B\u968F\u540E\u6309 control \u2192 dsh \u2192 gate \u7684\u987A\u5E8F\u91CD\u542F\u670D\u52A1\uFF0Cgateway \u6C38\u8FDC\u6700\u540E\u3002\u5065\u5EB7\u68C0\u67E5\u5931\u8D25\u4F1A\u81EA\u52A8\u5207\u56DE previous\u3002",
      "`status` / `logs` \u67E5\u770B\u90E8\u7F72 job\uFF1B`rollback` \u5207\u56DE\u4E0A\u4E00\u4E2A release\u3002",
      "\u76EE\u6807\u5FC5\u987B\u5DF2\u5B89\u88C5\u8FC7\u4E00\u6B21\uFF08\u5171\u4EAB config/gate.env \u5B58\u5728\uFF09\uFF0C\u5E76\u4E14 SSH \u4F7F\u7528\u5BC6\u94A5\u3001BatchMode \u53EF\u7528\uFF1BLinux \u9ED8\u8BA4 sudo -n\uFF0CWindows \u9700\u8981\u7BA1\u7406\u5458 SSH\u3002",
      "\u670D\u52A1\u6E05\u5355\u53EF\u4EE5\u7528 services \u6307\u5B9A\uFF1B\u987A\u5E8F\u7531\u5DE5\u5177\u5F3A\u5236\u4E3A control \u2192 dsh \u2192 gate\uFF0C\u6700\u540E\u4E00\u9879\u5FC5\u987B\u662F gateway\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["plan", "deploy", "status", "logs", "rollback"],
          description: "\u8981\u6267\u884C\u7684\u52A8\u4F5C\u3002"
        },
        host: { type: "string", description: "\u76EE\u6807 SSH \u4E3B\u673A\u540D\u6216 IP\u3002" },
        user: { type: "string", description: "SSH \u7528\u6237\uFF1B\u9ED8\u8BA4\u5F53\u524D\u7528\u6237\u3002" },
        port: { type: "number", description: "SSH \u7AEF\u53E3\uFF0C\u9ED8\u8BA4 22\u3002" },
        identityFile: { type: "string", description: "SSH \u79C1\u94A5\u8DEF\u5F84\u3002" },
        os: { type: "string", enum: ["linux", "windows"], description: "\u76EE\u6807\u7CFB\u7EDF\uFF0C\u9ED8\u8BA4 linux\u3002" },
        package: { type: "string", description: "\u672C\u5730\u79BB\u7EBF\u5305\u8DEF\u5F84\uFF1B\u7701\u7565\u65F6\u53D6 dist \u4E0B\u6700\u65B0\u7684\u5BF9\u5E94\u5E73\u53F0\u5305\u3002" },
        appRoot: { type: "string", description: "\u76EE\u6807\u7A33\u5B9A\u6839\u76EE\u5F55\uFF0C\u9ED8\u8BA4 /opt/dsh-person-web \u6216 C:\\dsh-person-web\u3002" },
        release: { type: "string", description: "\u53D1\u5E03 id\uFF0C\u9ED8\u8BA4\u65F6\u95F4\u6233+\u5305\u54C8\u5E0C\u3002" },
        services: {
          type: "array",
          description: "\u670D\u52A1\u6E05\u5355\uFF1Brole \u5FC5\u987B\u542B\u4E00\u4E2A gate\uFF0C\u5DE5\u5177\u4F1A\u628A gate \u653E\u5230\u6700\u540E\u3002",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              role: { type: "string", enum: ["control", "dsh", "gate"] },
              command: { type: "string", description: "\u76F8\u5BF9 current \u7684\u542F\u52A8\u547D\u4EE4\uFF0C\u9ED8\u8BA4 start.sh / dsh-person-web-service.exe\u3002" }
            },
            required: ["name"],
            additionalProperties: false
          }
        },
        scope: { type: "string", enum: ["all", "dsh"], description: "all \u91CD\u542F\u5168\u90E8\u670D\u52A1\uFF1Bdsh \u53EA\u91CD\u542F control/dsh\uFF0C\u4E0D\u52A8 gateway\u3002" },
        gatePort: { type: "string", description: "\u5065\u5EB7\u68C0\u67E5\u7AEF\u53E3\uFF0C\u9ED8\u8BA4 80\u3002" },
        retention: { type: "number", description: "\u4FDD\u7559\u6700\u8FD1\u51E0\u4E2A release\uFF0C\u9ED8\u8BA4 3\uFF1B\u81F3\u5C11 2\uFF08current + previous\uFF09\u3002" },
        sudo: { type: "boolean", description: "Linux \u4F7F\u7528 sudo -n \u6267\u884C\u8FDC\u7A0B\u811A\u672C\uFF0C\u9ED8\u8BA4 true\u3002" },
        includeScripts: { type: "boolean", description: "plan \u65F6\u540C\u65F6\u8FD4\u56DE prepare/activate/rollback \u811A\u672C\u5168\u6587\u3002" },
        jobId: { type: "string", description: "status / logs \u7684 job id\u3002" },
        lines: { type: "number", description: "logs \u8FD4\u56DE\u6700\u540E\u591A\u5C11\u884C\uFF0C\u9ED8\u8BA4 80\u3002" }
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
    async execute(args) {
      const action = String(args.action);
      if (action === "status") {
        const job = await service.deployStatus(requireJobId(args));
        return { ok: Boolean(job), text: job ? JSON.stringify(job, null, 2) : "\u672A\u627E\u5230\u8BE5\u90E8\u7F72 job", data: job };
      }
      if (action === "logs") {
        const text = await service.deployLogs(requireJobId(args), typeof args.lines === "number" ? args.lines : 80);
        return { ok: true, text: text || "(no log yet)" };
      }
      const request = deployRequest(args);
      if (action === "plan") {
        const result = await service.deployPlan(request);
        return { ok: true, text: formatDeployPlan(result.plan), data: result };
      }
      if (action === "deploy") {
        const result = await service.deployStart(request);
        return {
          ok: true,
          text: `\u90E8\u7F72 job ${result.job.id} \u5DF2\u542F\u52A8\uFF1B\u76EE\u6807 ${result.job.target.host}\uFF0Crelease ${result.job.release}\u3002\u7528 dsh_person_deploy action="status" jobId="${result.job.id}" \u67E5\u770B\u8FDB\u5EA6\u3002`,
          data: result
        };
      }
      if (action === "rollback") {
        const result = await service.deployRollback(request);
        return {
          ok: true,
          text: `\u56DE\u6EDA job ${result.job.id} \u5DF2\u542F\u52A8\uFF1B\u7528 status/logs \u67E5\u770B\u7ED3\u679C\u3002`,
          data: result
        };
      }
      throw new Error(`unknown action: ${action}`);
    }
  };
  const memberTasks = new MemberTaskService({
    ctx,
    service,
    dataDir: service.dataDir,
    log: (line) => ctx.logger?.info?.(`person-web: ${line}`)
  });
  try {
    ctx.effect(() => () => memberTasks.dispose(), "person-web member tasks");
  } catch {
  }
  const memberTaskDefinition = {
    name: "dsh_member_task",
    description: [
      "\u628A\u4EFB\u52A1\u4EA4\u7ED9\u53E6\u4E00\u4E2A WireGuard \u6210\u5458\u4E0A\u7684 DSH \u5BF9\u8BDD\uFF0C\u5E76\u5728\u5B83\u5B8C\u6210\u65F6\u901A\u77E5\u5F53\u524D\u4E3B\u5BF9\u8BDD\u3002",
      "",
      "`delegate`\uFF1A\u5728\u6210\u5458 B \u4E0A\u521B\u5EFA\u5BF9\u8BDD\u5E76\u5F02\u6B65\u6267\u884C\uFF1B\u5DE5\u5177\u7ACB\u5373\u8FD4\u56DE taskId\u3002B \u5B8C\u6210\u540E\uFF0C\u7ED3\u679C\u4F1A\u4F5C\u4E3A\u4E00\u6761\u65B0\u7684\u7528\u6237\u6D88\u606F\u5199\u56DE\u5F53\u524D A \u7684\u5BF9\u8BDD\uFF0C\u7C7B\u4F3C\u5B50\u4EE3\u7406\u5B8C\u6210\u901A\u77E5\u3002",
      "`run`\uFF1A\u540C\u6B65\u7B49\u5F85 B \u5B8C\u6210\u5E76\u76F4\u63A5\u8FD4\u56DE\u6700\u7EC8\u6587\u672C\u3002",
      "`send`\uFF1A\u5411\u5DF2\u7ECF\u521B\u5EFA\u7684\u6210\u5458\u4EFB\u52A1\u5BF9\u8BDD\u7EE7\u7EED\u53D1\u6D88\u606F\uFF0C\u5E76\u7EE7\u7EED\u7B49\u5F85/\u901A\u77E5\u3002",
      "`status` / `list` / `logs`\uFF1A\u67E5\u770B\u4EFB\u52A1\u3002",
      "`system`\uFF1A\u8BFB\u53D6\u6210\u5458 B \u7684 CPU/\u5185\u5B58/\u78C1\u76D8/\u7F51\u7EDC/\u8FDB\u7A0B\u57FA\u7840\u4FE1\u606F\u3002",
      "",
      "\u6210\u5458\u901A\u8FC7 WireGuard \u6210\u5458\u53D1\u73B0\u89E3\u6790\uFF08id/name/IP \u5747\u53EF\uFF09\uFF1B\u76EE\u6807 B \u7684 8765 interop \u670D\u52A1\u5FC5\u987B\u53EF\u8FBE\uFF0Ctoken \u9ED8\u8BA4\u590D\u7528\u7F51\u5173\u5BC6\u7801\uFF0C\u53EF\u7528 interopToken \u8986\u76D6\u3002"
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["delegate", "run", "send", "status", "list", "logs", "system"],
          description: "\u8981\u6267\u884C\u7684\u52A8\u4F5C\u3002"
        },
        member: { type: "string", description: "\u6210\u5458 id\u3001\u540D\u79F0\u3001VPN IP \u6216 http(s) URL\u3002" },
        prompt: { type: "string", description: "delegate/run\uFF1A\u4EA4\u7ED9\u6210\u5458 B \u7684\u4EFB\u52A1\u3002" },
        content: { type: "string", description: "send\uFF1A\u7EE7\u7EED\u53D1\u7ED9\u6210\u5458 B \u5BF9\u8BDD\u7684\u6D88\u606F\u3002" },
        taskId: { type: "string", description: "send/status/logs \u7684\u4EFB\u52A1 id\u3002" },
        cwd: { type: "string", description: "delegate/run\uFF1A\u6210\u5458 B \u4E0A\u7684\u5DE5\u4F5C\u76EE\u5F55\u3002" },
        lines: { type: "number", description: "logs \u8FD4\u56DE\u6700\u540E\u591A\u5C11\u884C\uFF0C\u9ED8\u8BA4 80\u3002" }
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
      if (action === "delegate" || action === "run") {
        if (typeof args.prompt !== "string" || args.prompt.trim() === "") throw new Error("this action needs prompt");
        const task = action === "delegate" ? await memberTasks.start({ member: args.member, prompt: args.prompt, cwd: args.cwd, agent: exec.agent, notify: true }) : await memberTasks.run({ member: args.member, prompt: args.prompt, cwd: args.cwd, agent: exec.agent });
        return {
          ok: task.status !== "failed",
          text: action === "delegate" ? `\u5DF2\u4EA4\u7ED9\u6210\u5458 ${task.member}\uFF08${task.memberIp}\uFF09\uFF0CtaskId ${task.id}\uFF0C\u5BF9\u8BDD ${task.conversationId}\u3002\u5B8C\u6210\u540E\u4F1A\u81EA\u52A8\u901A\u77E5\u5F53\u524D\u5BF9\u8BDD\u3002` : formatMemberTask(task),
          data: task
        };
      }
      if (action === "send") {
        if (typeof args.taskId !== "string" || args.taskId === "") throw new Error("send needs taskId");
        if (typeof args.content !== "string" || args.content.trim() === "") throw new Error("send needs content");
        const task = await memberTasks.send(args.taskId, args.content);
        return { ok: true, text: `\u5DF2\u53D1\u9001\u5230 ${task.member} \u7684\u5BF9\u8BDD ${task.conversationId}\uFF1B\u5B8C\u6210\u540E\u4F1A\u7EE7\u7EED\u901A\u77E5\u5F53\u524D\u5BF9\u8BDD\u3002`, data: task };
      }
      if (action === "status") {
        if (typeof args.taskId !== "string" || args.taskId === "") throw new Error("status needs taskId");
        const task = await memberTasks.status(args.taskId);
        return task === null ? { ok: false, text: "\u672A\u627E\u5230\u8BE5\u6210\u5458\u4EFB\u52A1\u3002" } : { ok: true, text: formatMemberTask(task), data: task };
      }
      if (action === "list") {
        const tasks = await memberTasks.list();
        return {
          ok: true,
          text: tasks.length === 0 ? "\u6CA1\u6709\u6210\u5458\u4EFB\u52A1\u3002" : tasks.map((task) => `- ${task.id}  ${task.member}  ${task.status}  ${task.lastText ? String(task.lastText).slice(0, 80) : task.error ?? ""}`).join("\n"),
          data: tasks
        };
      }
      if (action === "system") {
        if (typeof args.member !== "string" || args.member === "") throw new Error("system needs member");
        const info = await memberTasks.system(args.member);
        return { ok: true, text: formatMemberSystem(info), data: info };
      }
      if (action === "logs") {
        if (typeof args.taskId !== "string" || args.taskId === "") throw new Error("logs needs taskId");
        const text = await memberTasks.logs(args.taskId, typeof args.lines === "number" ? args.lines : 80);
        return { ok: true, text: text || "(no log yet)" };
      }
      throw new Error(`unknown action: ${action}`);
    }
  };
  for (const tool of [definition, deployDefinition, memberTaskDefinition]) {
    try {
      toolsCtx.tools.register(tool);
      ctx.logger?.info?.(`person-web: registered tool ${tool.name}`);
    } catch (error) {
      ctx.logger?.error?.(`person-web: cannot register tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
function deployRequest(args) {
  const request = {};
  for (const key of ["host", "user", "port", "identityFile", "os", "package", "appRoot", "release", "scope", "gatePort", "retention", "sudo", "includeScripts"]) {
    if (args[key] !== void 0) request[key] = args[key];
  }
  if (Array.isArray(args.services)) request.services = args.services;
  return request;
}
function formatDeployPlan(plan) {
  const target = plan.target;
  return [
    `\u76EE\u6807\uFF1A${target.user ? `${target.user}@` : ""}${target.host}:${target.port}\uFF08${target.os}\uFF09`,
    `\u5B89\u88C5\u6839\uFF1A${target.appRoot}`,
    `\u53D1\u5E03\uFF1A${plan.release}`,
    `\u5305\uFF1A${plan.package.path}\uFF08${plan.package.bytes} bytes\uFF0Csha256 ${plan.package.sha256.slice(0, 12)}\u2026\uFF09`,
    `\u670D\u52A1\u987A\u5E8F\uFF1A${plan.services.map((service) => `${service.name}(${service.role})`).join(" \u2192 ")}`,
    `\u8303\u56F4\uFF1A${plan.scope === "dsh" ? "\u53EA\u91CD\u542F DSH/\u63A7\u5236\u9762\u677F\uFF0C\u7F51\u5173\u4E0D\u52A8" : "\u5168\u90E8\u91CD\u542F\uFF0C\u7F51\u5173\u6700\u540E"}`,
    "\u6B65\u9AA4\uFF1A",
    ...plan.steps.map((step, index) => `  ${index + 1}. ${step}`)
  ].join("\n");
}
function formatMemberSystem(info) {
  const gb = (bytes) => `${(Number(bytes) / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  const lines = [
    `\u6210\u5458 ${info.member}\uFF08${info.memberIp}\uFF09`,
    `\u4E3B\u673A\uFF1A${info.hostname}  ${info.platform}-${info.arch}  uptime ${String(info.uptimeSeconds)}s`,
    `CPU\uFF1A${info.cpu?.model ?? "unknown"}\uFF0C${String(info.cpu?.cores ?? 0)} \u6838\uFF0C\u4F7F\u7528\u7387 ${String(info.cpu?.usagePercent ?? 0)}%`,
    `\u5185\u5B58\uFF1A${gb(info.memory?.usedBytes ?? 0)} / ${gb(info.memory?.totalBytes ?? 0)}\uFF08${String(info.memory?.usedPercent ?? 0)}%\uFF09`
  ];
  for (const disk of info.disks ?? []) {
    lines.push(`\u78C1\u76D8 ${disk.mount}\uFF1A${gb(disk.usedBytes)} / ${gb(disk.totalBytes)}\uFF08${String(disk.usedPercent)}%\uFF09`);
  }
  return lines.join("\n");
}
function formatMemberTask(task) {
  const lines = [
    `\u4EFB\u52A1 ${task.id}\uFF1A${task.member}\uFF08${task.memberIp}\uFF09\uFF0C\u5BF9\u8BDD ${task.conversationId}`,
    `\u72B6\u6001\uFF1A${task.status}${task.notified ? "\uFF0C\u5DF2\u901A\u77E5\u4E3B\u5BF9\u8BDD" : ""}`
  ];
  if (task.error) lines.push(`\u9519\u8BEF\uFF1A${task.error}`);
  if (task.lastText) lines.push(`\u7ED3\u679C\uFF1A
${task.lastText}`);
  if (task.notifyError) lines.push(`\u901A\u77E5\u5931\u8D25\uFF1A${task.notifyError}`);
  return lines.join("\n");
}
function requireJobId(args) {
  if (typeof args.jobId !== "string" || args.jobId === "") throw new Error("this action needs jobId");
  return args.jobId;
}
function formatStatus(status) {
  const wireguard = status.wireguard;
  return [
    `\u4E3B\u673A\uFF1A${status.host.hostname}\uFF08${status.host.platform}-${status.host.arch}\uFF09`,
    wireguard.available ? `WireGuard\uFF1A${wireguard.role}\uFF0C${wireguard.connected ? "\u5DF2\u8FDE\u63A5" : "\u672A\u8FDE\u63A5"}\uFF0C\u672C\u673A ${wireguard.selfIp || "\u2014"}\uFF0C\u670D\u52A1\u5668 ${wireguard.serverIp}` : `WireGuard\uFF1A\u4E0D\u53EF\u7528\uFF08${wireguard.error ?? "unknown"}\uFF09`,
    `\u6784\u5EFA\u9ED8\u8BA4\uFF1A${status.build.source || "(recipes)"}@${status.build.ref} -> ${status.build.targets.join(", ")}`,
    status.wireguard.warnings?.length ? `\u8B66\u544A\uFF1A${status.wireguard.warnings.join("\uFF1B")}` : ""
  ].filter(Boolean).join("\n");
}
function formatMembers(snapshot) {
  const lines = [`\u66F4\u65B0\u4E8E ${snapshot.updatedAt}\uFF0C\u5171 ${snapshot.members.length} \u4E2A\u6210\u5458`];
  for (const member of snapshot.members) {
    const status = member.id === "local" ? "\u672C\u673A" : member.dsh ? `DSH :${member.port}` : "\u672A\u90E8\u7F72/\u4E0D\u53EF\u8FBE";
    lines.push(`- ${member.name}  ${member.id}  ${status}  ${member.online ? "online" : "offline"}`);
  }
  if (snapshot.warnings?.length) lines.push(`\u8B66\u544A\uFF1A${snapshot.warnings.join("\uFF1B")}`);
  return lines.join("\n");
}

// src/index.ts
var inject = ["webServer"];
function dataDirectory() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path7.join(homedir(), ".dsh");
  return path7.join(home, "person-web");
}
async function apply(ctx, config = {}) {
  const service = new PersonWebService({
    dataDir: dataDirectory(),
    config,
    log: (line) => console.log(line)
  });
  ctx.effect(() => () => {
    void service.dispose();
  }, "person-web service lifetime");
  registerApi(ctx, service);
  try {
    ctx.inject(["tools"], (toolsCtx) => {
      registerTools(ctx, toolsCtx, service);
    });
  } catch (error) {
    console.error(`person-web: tools service is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export {
  apply,
  inject
};
