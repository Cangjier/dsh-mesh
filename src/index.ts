/** Host entry for the personal DSH web plugin. */

import { homedir } from 'node:os'
import path from 'node:path'
import { MeshService } from './lib/service.mjs'
import { registerApi } from './lib/http-api.mjs'
import { Scheduler } from './lib/scheduler.mjs'
import { scheduleFile } from './lib/schedule.mjs'
import { registerWireGuardApi } from './lib/wireguard-api.mjs'
import { registerTools } from './lib/tools.mjs'

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
    // ids to apply the default 06:00 entry to members without an override.
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
}
