/**
 * Standalone WireGuard control service.
 *
 * It owns the 51821 listener for the server member. The DSH plugin, when
 * configured with `externalControlPanel: true`, proxies its built-in panel API
 * to this listener and never starts a second copy. Stopping or restarting DSH
 * therefore cannot take 51821 down.
 *
 * Run with the DSH home in DSH_HOME, for example:
 *   DSH_HOME=/root/.dsh node control-service.js
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { createControlExtraHandler } from './lib/http-api';
import { WireGuardService } from './lib/service';

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path.join(homedir(), '.dsh');
const service = new WireGuardService({
  config: {
    externalControlPanel: true,
    keepTunnelOnExit: true,
  },
  dataDir: path.join(home, 'wireguard'),
  log: (line) => console.log(`[wireguard-control] ${line}`),
});

// The shared listener also answers the public /join and /leave routes, so the
// panel API only claims requests below its own prefix.
service.setControlExtraHandler(createControlExtraHandler(service));
await service.init();
await service.startControlPanel();
console.log('[wireguard-control] ready; control panel owns 51821');

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[wireguard-control] ${signal}; stopping the listener`);
  await service.dispose();
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

// Keep the process alive; the listener and its timers are the actual work.
setInterval(() => {}, 1 << 30);
