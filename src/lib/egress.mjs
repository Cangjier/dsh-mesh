/**
 * Compatibility re-export.
 *
 * The proxy manager moved into `code/shared/egress.mjs` because a detached
 * deploy runner (which only ships `code/`, not `src/`) now starts the same
 * proxy for a member's release download. Keeping this module means existing
 * imports and tests keep working.
 *
 * @module @local/dsh-mesh/egress
 */

export { EgressProxy, resolveEgressScript } from '../../code/shared/egress.mjs'
