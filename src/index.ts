/** Host entry for the personal DSH web plugin. */

import { homedir } from 'node:os'
import path from 'node:path'
import { MeshService } from './lib/service.mjs'
import { registerApi } from './lib/http-api.mjs'
import { Scheduler } from './lib/scheduler.mjs'
import { scheduleFile } from './lib/schedule.mjs'
import { registerWireGuardApi } from './lib/wireguard-api.mjs'
import { registerTools } from './lib/tools.mjs'
import { createInteropService, resolveInteropSettings } from './lib/interop-service.mjs'
import { armUpgradeResume } from './lib/upgrade-announce.mjs'

export const inject = ['webServer']

/**
 * Resolve the durable plugin directory below the Harness home.
 * @returns {string} absolute directory.
 */
function dataDirectory() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
  return path.join(home, 'mesh')
}

/**
 * Activate the host service, the panel API, and the build tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {Record<string, unknown>} [config] bundle row configuration.
 * @returns {Promise<void>}
 */
export async function apply(ctx: any, config: any = {}) {
  const service = new MeshService({
    dataDir: dataDirectory(),
    config,
    log: line => console.log(line),
  })
  ctx.effect(() => () => {
    void service.dispose()
  }, 'mesh service lifetime')
  const scheduler = new Scheduler({
    service,
    file: scheduleFile(dataDirectory()),
    // Auto-upgrade is configured per member; the scheduler needs the current
    // ids to apply the default 06:00 entry (off until enabled) to members
    // without an override.
    members: async () => {
      const snapshot = await service.members()
      return [snapshot.local?.id, ...snapshot.members.map((member: { id: string }) => member.id)].filter((id): id is string => typeof id === 'string' && id !== '')
    },
    log: line => console.log(`mesh schedule: ${line}`),
  })
  ctx.effect(() => () => scheduler.dispose(), 'mesh schedule lifetime')
  registerApi(ctx, service, scheduler)
  registerWireGuardApi(ctx)
  try {
    ctx.inject(['tools'], (toolsCtx: any) => {
      registerTools(ctx, toolsCtx, service)
    })
  } catch (error) {
    console.error(`mesh: tools service is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Run the member-facing interop HTTP service inside this Web host. The
  // sessions it creates are the host's own agents, so the Web UI sees a live
  // conversation instead of cold-reading another process's half-written log.
  // A profile without the agent registry (a non-Web launch) simply never runs
  // this block. `interopEmbedded: false` is the emergency fallback to the
  // standalone `code/interop-service/server.mjs`.
  // The pre-upgrade announcement persists which conversations it stopped. A
  // restart consumes it: two minutes after the plugin is up, the leader and
  // plain conversations get "重启成功，请继续。". Member conversations are left
  // to their initiator. Arming needs no agents yet; the resume looks them up
  // when the timer fires.
  const upgradePlanFile = path.join(dataDirectory(), 'upgrade-plan.json')
  void armUpgradeResume(ctx, {
    planFile: upgradePlanFile,
    log: (line: string) => console.log(`mesh upgrade: ${line}`),
  }).catch((error: unknown) => {
    console.error(`mesh upgrade: could not arm the resume: ${error instanceof Error ? error.message : String(error)}`)
  })

  if (config.interopEmbedded !== false) {
    try {
      ctx.inject(['agents'], (agentsCtx: any) => {
        let settings: Record<string, any>
        try {
          settings = (resolveInteropSettings as unknown as (config: Record<string, unknown>) => Record<string, any>)(config)
        } catch (error) {
          console.error(`mesh interop: could not resolve settings: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        const interop = (createInteropService as unknown as (options: {
          ctx: any
          settings: Record<string, any>
          config: Record<string, any>
          upgradePlanFile?: string
          log: (line: string) => void
        }) => { start(): Promise<{ port: number }>; dispose(): Promise<void> })({
          ctx: agentsCtx,
          settings,
          config,
          // Both ends of the announcement use the same file: the endpoint
          // writes it, the resume timer above consumes it after the restart.
          upgradePlanFile,
          log: line => console.log(line),
        })
        agentsCtx.effect(() => () => {
          void interop.dispose()
        }, 'mesh embedded interop lifetime')
        void interop.start().catch((error: unknown) => {
          console.error(`mesh interop: listener failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      })
    } catch (error) {
      console.error(`mesh: agent registry is unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
