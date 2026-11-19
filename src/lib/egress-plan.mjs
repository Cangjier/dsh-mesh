/**
 * Egress planning for build and deploy jobs.
 *
 * A direct (hysteria2) link is a transport between two members, not a proxy
 * setting. The gate stores one record per link in `links.json`; build and
 * deploy read that record and prefer the link when the job's machine is the
 * link's client, because the link's local HTTP listener already forwards
 * through the server's internet access.
 *
 * The functions here are pure so the priority rules are testable: explicit
 * proxy, then forced direct, then a direct link (when it points at the chosen
 * egress member), then the classic egress-proxy member, then no proxy.
 *
 * @module @local/dsh-mesh/egress-plan
 */

/**
 * The link whose client is this member.
 * @param {object[]} links live link records.
 * @param {object|null|undefined} member member snapshot.
 * @returns {object|null} link record.
 */
export function linkFor(links, member) {
  if (member === null || member === undefined || !Array.isArray(links)) return null
  return links.find(link =>
    link?.client?.ip === member.ip
    || (member.id !== undefined && link?.client?.id === member.id)
    || (member.name !== undefined && link?.client?.name === member.name)) ?? null
}

/**
 * Whether a link carries an HTTP proxy that a job on the client can use.
 * @param {object|null} link link record.
 * @returns {boolean} usable.
 */
export function linkHasProxy(link) {
  return link !== null && link !== undefined && typeof link.httpProxy === 'string' && link.httpProxy !== ''
}

/**
 * Whether a proxy-member selection points at the link's server.
 * @param {object|null} proxyMember member snapshot.
 * @param {object} link link record.
 * @returns {boolean} match.
 */
export function isLinkServer(proxyMember, link) {
  if (proxyMember === null || proxyMember === undefined) return false
  return proxyMember.id === link?.server?.id
    || proxyMember.ip === link?.server?.ip
    || proxyMember.name === link?.server?.name
}

/**
 * Choose how a build reaches the internet.
 * @param {{links: object[], member: object|null, proxyUrl?: string, proxyMember?: object|null, direct?: boolean}} options choices.
 * @returns {{kind: 'link'|'proxyMember'|'explicit'|'direct', url?: string, link?: object, proxyMember?: object, reason: string}} plan.
 */
export function resolveBuildEgress(options) {
  const proxyUrl = typeof options.proxyUrl === 'string' ? options.proxyUrl.trim() : ''
  const proxyMember = options.proxyMember ?? null
  if (proxyUrl !== '') return { kind: 'explicit', url: proxyUrl, reason: '显式代理' }
  if (options.direct === true) return { kind: 'direct', reason: 'direct=true' }
  const link = linkFor(options.links ?? [], options.member ?? null)
  if (linkHasProxy(link) && (proxyMember === null || isLinkServer(proxyMember, link))) {
    return {
      kind: 'link',
      url: link.httpProxy,
      link,
      reason: `直连 ${link.server?.name ?? link.server?.ip}（hysteria2/${link.mode ?? 'socks'}，HTTP ${link.httpProxy}）`,
    }
  }
  if (proxyMember !== null) return { kind: 'proxyMember', proxyMember, reason: `代理成员 ${proxyMember.name}` }
  return { kind: 'direct', reason: '不使用代理' }
}

/**
 * The direct-link proxy a deploy download may use.
 *
 * The downloader runs on the target, so the link's loopback listener is
 * directly reachable. An explicit proxy member is honoured unless it names the
 * link's server (in which case the link is the faster route to that member).
 * @param {{links: object[], target: object|null, wanted?: string}} options choices.
 * @returns {{kind: 'link', url: string, name: string}|null} proxy spec.
 */
export function resolveDeployLinkProxy(options) {
  const target = options.target ?? null
  const wanted = typeof options.wanted === 'string' ? options.wanted.trim() : ''
  if (target === null) return null
  const link = linkFor(options.links ?? [], target)
  if (!linkHasProxy(link)) return null
  if (wanted === '' || wanted === 'auto') {
    return { kind: 'link', url: link.httpProxy, name: link.server?.name ?? link.server?.ip ?? 'direct link' }
  }
  const server = link.server ?? {}
  if (wanted === server.id || wanted === server.ip || wanted === server.name) {
    return { kind: 'link', url: link.httpProxy, name: server.name ?? server.ip ?? 'direct link' }
  }
  return null
}
