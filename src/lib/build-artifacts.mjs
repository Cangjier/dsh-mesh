/**
 * Match a finished build to the machine that ran it.
 *
 * A build can package several targets (`linux-x64` + `win-x64`), while an
 * auto-upgrade can only use the archive for the build host itself. The panel
 * and the service share this small pure decision so a Windows build host never
 * tries to activate a Linux package (and vice versa).
 *
 * @module @local/dsh-mesh/build-artifacts
 */

/**
 * The build target that matches a member's OS and CPU architecture.
 *
 * `node` reports `linux`/`win32` and `x64`/`arm64`; the engine's target names
 * use `linux-x64` and `win-x64`. Anything else (darwin, unknown arch) has no
 * deployable target and returns null.
 * @param {object|null|undefined} member member row.
 * @returns {string|null} target name, or null.
 */
export function memberBuildTarget(member) {
  const platform = String(member?.system?.platform ?? '').trim().toLowerCase()
  const arch = String(member?.system?.arch ?? '').trim().toLowerCase()
  if (arch !== 'x64' && arch !== 'arm64') return null
  if (platform.startsWith('linux')) return `linux-${arch}`
  if (platform.startsWith('win')) return `win-${arch}`
  return null
}

/**
 * Pick the built archive that belongs to a member.
 * @param {Array<object>|null|undefined} artifacts build artifacts.
 * @param {object|null|undefined} member member row.
 * @returns {object|null} artifact, or null when this build did not package it.
 */
export function pickArtifactForMember(artifacts, member) {
  const target = memberBuildTarget(member)
  if (target === null) return null
  const list = Array.isArray(artifacts) ? artifacts : []
  return list.find(artifact => artifact !== null && typeof artifact === 'object' && artifact.target === target) ?? null
}
