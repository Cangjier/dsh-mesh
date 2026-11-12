import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeState, Store } from '../../src/wireguard/lib/store';

test('Windows config files use the tunnel name as the basename', () => {
  const store = new Store('C:\\wireguard-data');
  assert.match(store.configPath('server', 'dshwg0', true), /dshwg0\.conf$/);
  assert.match(store.configPath('client', 'dshwg0', true), /dshwg0\.conf$/);
  assert.match(store.configPath('server', 'dshwg0', false), /server\.conf$/);
  assert.match(store.configPath('client', 'dshwg0', false), /client\.conf$/);
});


test('old peer records load with egress off and no platform', () => {
  const state = normalizeState({
    version: 1,
    server: {
      peers: [
        { publicKey: 'old-key', ip: '10.66.66.2', name: 'old-client', applied: true },
        { publicKey: 'new-key', ip: '10.66.66.3', name: 'new-client', egress: true, platform: 'windows' },
      ],
    },
  });
  assert.equal(state.server.peers[0].egress, false);
  assert.equal(state.server.peers[0].platform, null);
  assert.equal(state.server.peers[1].egress, true);
  assert.equal(state.server.peers[1].platform, 'windows');
});
