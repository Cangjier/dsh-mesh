/**
 * Which member the deploy-package panel should preselect.
 *
 * The panel used to start at "本机 / 直连 / linux-x64", which made the two
 * useful choices manual every time: the build wants the biggest machine, and
 * the downloads want a member whose public address is abroad. These helpers
 * keep that policy in one pure place so the browser and the tests agree.
 *
 * They never start anything and never mutate their input.
 *
 * @module @local/dsh-mesh/build-defaults
 */

/** Fresh panels build both platforms; a missing arch is harder to notice later. */
export const DEFAULT_BUILD_TARGETS = Object.freeze(['linux-x64', 'win-x64'])

/**
 * Lowest-case platform name from a member snapshot.
 * @param {object} member member row.
 * @returns {string} `linux`, `win32`, `darwin`, or ''.
 */
export function memberPlatform(member) {
  return String(member?.system?.platform ?? '').trim().toLowerCase()
}

/**
 * Whether a member can host the build.
 *
 * The engine runs on Linux and Windows; a member with no platform answer is
 * kept as a candidate because the probe may simply be absent.
 * @param {object} member member row.
 * @returns {boolean} whether it can build.
 */
export function canBuildOn(member) {
  if (member === null || typeof member !== 'object') return false
  if (member.online === false) return false
  const platform = memberPlatform(member)
  return platform === '' || platform.startsWith('linux') || platform.startsWith('win')
}

/**
 * Whether a member can host the outbound HTTP proxy.
 *
 * The proxy is one Node script started with `bash -s`, so Windows members are
 * not eligible and the local gateway is excluded (it cannot proxy its own
 * build).
 * @param {object} member member row.
 * @returns {boolean} whether it can be the proxy.
 */
export function canProxyThrough(member) {
  if (member === null || typeof member !== 'object') return false
  if (member.id === 'local' || member.kind === 'self') return false
  if (member.online === false) return false
  const platform = memberPlatform(member)
  return platform === '' || platform.startsWith('linux')
}

/**
 * CPU cores reported for a member, or 0 when the probe has not answered.
 * @param {object} member member row.
 * @returns {number} core count.
 */
export function memberCores(member) {
  const value = Number(member?.system?.cpu?.cores)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Total memory reported for a member, or 0 when the probe has not answered.
 * @param {object} member member row.
 * @returns {number} bytes.
 */
export function memberMemoryBytes(member) {
  const value = Number(member?.system?.memory?.totalBytes)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Whether a member's public address is outside mainland China.
 *
 * The country comes from the endpoint lookup. When that lookup is unavailable
 * (offline gateway, private endpoint, or a brand-new member) a tag such as
 * 「国外」/「海外」 is honoured as an explicit operator hint.
 * @param {object} member member row.
 * @returns {boolean} whether it is a foreign member.
 */
export function isForeignMember(member) {
  const code = typeof member?.countryCode === 'string' ? member.countryCode.trim().toUpperCase() : ''
  if (/^[A-Z]{2}$/u.test(code)) return code !== 'CN'
  const tag = typeof member?.tag === 'string' ? member.tag : ''
  // 「可访问外网」 is an explicit operator hint that this member has usable
  // external access even when the country lookup is unavailable.
  return /(?:国外|境外|海外|foreign|overseas|可访问外网|外网)/iu.test(tag)
}

/**
 * Compare two members by build capacity: cores first, then memory, then the
 * lower current CPU load, then the local machine (so a tie does not make the
 * panel jump between hosts).
 * @param {object} left first member.
 * @param {object} right second member.
 * @returns {number} negative when left is richer.
 */
export function compareBuildCapacity(left, right) {
  const cores = memberCores(right) - memberCores(left)
  if (cores !== 0) return cores
  const memory = memberMemoryBytes(right) - memberMemoryBytes(left)
  if (memory !== 0) return Math.sign(memory)
  const leftUsage = Number(left?.system?.cpu?.usagePercent)
  const rightUsage = Number(right?.system?.cpu?.usagePercent)
  const usageLeft = Number.isFinite(leftUsage) ? leftUsage : Number.POSITIVE_INFINITY
  const usageRight = Number.isFinite(rightUsage) ? rightUsage : Number.POSITIVE_INFINITY
  if (usageLeft !== usageRight) return usageLeft - usageRight
  if (left?.id === 'local' && right?.id !== 'local') return -1
  if (right?.id === 'local' && left?.id !== 'local') return 1
  return String(left?.name ?? '').localeCompare(String(right?.name ?? ''))
}

/**
 * The member a fresh panel should build on: the most CPU/memory among the
 * online Linux/Windows members. The local gateway is a candidate like any
 * other; a peer only wins when it really is bigger.
 * @param {object[]} members local + peers.
 * @returns {string} member id, `local` when nothing else is usable.
 */
export function pickBuildMember(members) {
  const candidates = Array.isArray(members) ? members.filter(canBuildOn) : []
  if (candidates.length === 0) return 'local'
  return [...candidates].sort(compareBuildCapacity)[0]?.id ?? 'local'
}

/**
 * The member a fresh panel should use as the outbound proxy: a foreign Linux
 * member, preferring a reachable DSH, then the lowest WireGuard latency, then
 * the bigger machine.
 * @param {object[]} members local + peers.
 * @returns {string|null} member id, or null when no foreign member is known.
 */
export function pickProxyMember(members) {
  const candidates = Array.isArray(members)
    ? members.filter(member => canProxyThrough(member) && isForeignMember(member))
    : []
  if (candidates.length === 0) return null
  const latency = member => (Number.isFinite(Number(member?.latencyMs)) ? Number(member.latencyMs) : Number.POSITIVE_INFINITY)
  return [...candidates].sort((left, right) => {
    const reachable = (right.dsh === false ? 1 : 0) - (left.dsh === false ? 1 : 0)
    if (reachable !== 0) return reachable
    const rtt = latency(left) - latency(right)
    if (rtt !== 0) return rtt
    return compareBuildCapacity(left, right)
  })[0]?.id ?? null
}
