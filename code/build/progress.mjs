/**
 * Target-aware progress for a build job.
 *
 * A job can package several targets (linux-x64 + win-x64). One monotonic
 * counter that jumps to "smoke 92%" per target is wrong in that case: the
 * second target re-runs the same phases, so the bar stalls at the first
 * target's numbers until the job is done. Instead the packaging share of the
 * job is divided evenly between the targets, and every target walks its own
 * slice (assemble → smoke → archive).
 *
 * The same mapping is used by the local engine (structured calls) and by a
 * remote build (log-line markers), so both hosts show the same numbers.
 *
 * @module @local/dsh-mesh/build/progress
 */

/** Percent of the job owned by prepare/apply/install/web build. */
export const BUILD_DONE = 65
/** Percent reached when every target has been packaged. */
export const PACKAGE_END = 95
/** Stage inside one target's slice. */
const STAGE_FACTOR = { start: 0, smoke: 0.55, end: 1 }

/**
 * First and last percent of one target's slice.
 * @param {string[]} targets every target of the job, in run order.
 * @param {string} target target name.
 * @returns {{start: number, end: number}} rounded bounds.
 */
export function targetRange(targets, target) {
  const list = Array.isArray(targets) && targets.length > 0 ? targets : ['linux-x64']
  const index = Math.max(0, list.indexOf(target))
  const span = (PACKAGE_END - BUILD_DONE) / list.length
  return {
    start: Math.round(BUILD_DONE + span * index),
    end: Math.round(BUILD_DONE + span * (index + 1)),
  }
}

/**
 * Percent inside one target's slice.
 * @param {string[]} targets every target of the job, in run order.
 * @param {string} target target being worked on.
 * @param {'start'|'smoke'|'end'} stage stage within the slice.
 * @returns {number} percent.
 */
export function targetPercent(targets, target, stage = 'start') {
  const { start, end } = targetRange(targets, target)
  const factor = STAGE_FACTOR[stage] ?? 0
  return Math.round(start + (end - start) * factor)
}

/**
 * Map one engine log line onto a phase, percent, and the target it names.
 *
 * The engine prints stable markers (`extracting`, `$ pnpm install`,
 * `packaged <target>:`, `smoke <target>:`) that a remote build sees as text.
 * @param {string} line log line.
 * @param {string[]} [targets] targets of this job.
 * @returns {{phase: string, percent?: number, currentTarget?: string, status?: string}|null} update.
 */
export function phaseFromLine(line, targets = ['linux-x64']) {
  const text = String(line)
  if (text.includes('job created')) return { phase: 'prepare', percent: 2 }
  if (text.includes('extracting ')) return { phase: 'prepare', percent: 6 }
  if (text.includes('needs-fix')) return { phase: 'apply', percent: 14, status: 'needs-fix' }
  if (/^(?:applied|skipped) /u.test(text)) return { phase: 'apply', percent: 11 }
  if (text.includes('$ pnpm install') || text.includes('$ pnpm i')) return { phase: 'build', percent: 18 }
  if (text.includes('$ pnpm run build:web') || text.includes('$ pnpm build')) return { phase: 'build', percent: 50 }
  if (text.includes('frontend installed') || text.includes('patching ')) {
    const first = Array.isArray(targets) && targets.length > 0 ? targets[0] : 'linux-x64'
    return { phase: 'package', percent: targetPercent(targets, first, 'start'), currentTarget: first }
  }
  const packaged = /^packaged (\S+):/u.exec(text)
  if (packaged !== null) {
    return {
      phase: 'package',
      percent: targetPercent(targets, packaged[1], 'end'),
      currentTarget: packaged[1],
    }
  }
  const smoke = /^smoke (\S+): (starting|passed|skipped|failed)/u.exec(text)
  if (smoke !== null) {
    if (smoke[2] === 'failed') {
      return { phase: 'smoke', percent: targetPercent(targets, smoke[1], 'end'), currentTarget: smoke[1], status: 'smoke-failed' }
    }
    return {
      phase: 'smoke',
      percent: targetPercent(targets, smoke[1], smoke[2] === 'starting' ? 'smoke' : 'end'),
      currentTarget: smoke[1],
    }
  }
  // The member has finished packaging, but the gateway still has to pull the
  // archives (hundreds of MiB over the mesh) and clean the member up. Calling
  // that "done" while the job is still running made the panel show "编译中"
  // next to "完成"; fetch is the honest phase until the artifacts are local.
  if (text.includes('build complete')) return { phase: 'fetch', percent: 96 }
  // A failure keeps whatever percent the job reached; the caller settles the
  // final state from the engine's state file.
  if (text.includes('failed:')) return { phase: 'failed', status: 'failed' }
  return null
}
