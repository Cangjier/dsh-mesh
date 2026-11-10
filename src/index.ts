/** Host entry for the personal DSH web plugin. */

import { homedir } from 'node:os'
import path from 'node:path'
import { PersonWebService } from './lib/service.mjs'
import { registerApi } from './lib/http-api.mjs'
import { registerTools } from './lib/tools.mjs'

export const inject = ['webServer']

/**
 * Resolve the durable plugin directory below the Harness home.
 * @returns {string} absolute directory.
 */
function dataDirectory() {
  const home = process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : path.join(homedir(), '.dsh')
  return path.join(home, 'person-web')
}

/**
 * Activate the host service, the panel API, and the build tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context.
 * @param {Record<string, unknown>} [config] bundle row configuration.
 * @returns {Promise<void>}
 */
export async function apply(ctx: any, config: any = {}) {
  const service = new PersonWebService({
    dataDir: dataDirectory(),
    config,
    log: line => console.log(line),
  })
  ctx.effect(() => () => {
    void service.dispose()
  }, 'person-web service lifetime')
  registerApi(ctx, service)
  try {
    ctx.inject(['tools'], (toolsCtx: any) => {
      registerTools(ctx, toolsCtx, service)
    })
  } catch (error) {
    console.error(`person-web: tools service is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}
