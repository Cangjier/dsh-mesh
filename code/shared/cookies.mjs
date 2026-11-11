/**
 * Cookie isolation for member proxies.
 *
 * Every member has its own DSH and gate cookie namespace. The outer gate strips
 * its own cookies before forwarding, renames each upstream `Set-Cookie` to a
 * member-scoped name, and renames it back on the next request. Without this,
 * `dsh_gate` from one member would be read by another member's gate, and
 * switching members would log the browser out of both.
 *
 * @module dsh-mesh/shared/cookies
 */

/** Prefix for every cookie that belongs to a member upstream. */
const MEMBER_PREFIX = 'dsh_m_'

/**
 * Build the cookie-name prefix for one member.
 * @param {string} id member id.
 * @returns {string} prefix such as `dsh_m_10.66.66.2_`.
 */
export function memberCookiePrefix(id) {
  return `${MEMBER_PREFIX}${encodeURIComponent(id)}_`
}

/**
 * Rename one upstream `Set-Cookie` header into the member namespace.
 * `Domain` is dropped: a member must never be able to set a cookie for the
 * outer host, and a host-only cookie is what the per-member namespace needs.
 * @param {string} id member id.
 * @param {string} header one `Set-Cookie` value.
 * @returns {string} rewritten header.
 */
export function namespaceSetCookie(id, header) {
  if (typeof header !== 'string' || header === '') return header
  const prefix = memberCookiePrefix(id)
  const separator = header.indexOf(';')
  const pair = separator === -1 ? header : header.slice(0, separator)
  let attributes = separator === -1 ? '' : header.slice(separator)
  const equals = pair.indexOf('=')
  if (equals <= 0) return header
  const name = pair.slice(0, equals).trim()
  const value = pair.slice(equals + 1).trim()
  if (name.startsWith(prefix)) return header
  attributes = attributes.replace(/;\s*domain=[^;]*/giu, '')
  if (!/;\s*path=/iu.test(attributes)) attributes += '; Path=/'
  return `${prefix}${name}=${value}${attributes}`
}

/**
 * Rewrite a browser `Cookie` header into the cookies one member owns.
 * The outer gate's own cookies are dropped here; that is the point.
 * @param {string} id member id.
 * @param {string|undefined} header browser cookie header.
 * @returns {string} cookie header for the member, possibly empty.
 */
export function rewriteCookieHeader(id, header) {
  if (typeof header !== 'string' || header === '') return ''
  const prefix = memberCookiePrefix(id)
  const kept = []
  for (const part of header.split(';')) {
    const item = part.trim()
    if (item === '') continue
    const equals = item.indexOf('=')
    if (equals <= 0) continue
    const name = item.slice(0, equals).trim()
    if (!name.startsWith(prefix)) continue
    kept.push(`${name.slice(prefix.length)}=${item.slice(equals + 1).trim()}`)
  }
  return kept.join('; ')
}

/**
 * Remove named cookies from a browser cookie header, keeping everything else.
 * @param {string|undefined} header browser cookie header.
 * @param {Iterable<string>} names cookie names to drop.
 * @returns {string} filtered header.
 */
export function stripCookieHeader(header, names) {
  if (typeof header !== 'string' || header === '') return ''
  const dropped = new Set([...names].map(name => name.toLowerCase()))
  const kept = []
  for (const part of header.split(';')) {
    const item = part.trim()
    if (item === '') continue
    const equals = item.indexOf('=')
    if (equals <= 0) continue
    const name = item.slice(0, equals).trim()
    if (dropped.has(name.toLowerCase())) continue
    kept.push(item)
  }
  return kept.join('; ')
}

/**
 * Read one cookie value out of a header.
 * @param {string|undefined} header browser cookie header.
 * @param {string} name exact cookie name.
 * @returns {string|undefined} value, or undefined.
 */
export function cookieValue(header, name) {
  if (typeof header !== 'string' || header === '') return undefined
  for (const part of header.split(';')) {
    const item = part.trim()
    const equals = item.indexOf('=')
    if (equals <= 0) continue
    if (item.slice(0, equals).trim() !== name) continue
    return item.slice(equals + 1).trim()
  }
  return undefined
}
