import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../src/wireguard/lib/store';

test('Windows config files use the tunnel name as the basename', () => {
  const store = new Store('C:\\wireguard-data');
  assert.match(store.configPath('server', 'dshwg0', true), /dshwg0\.conf$/);
  assert.match(store.configPath('client', 'dshwg0', true), /dshwg0\.conf$/);
  assert.match(store.configPath('server', 'dshwg0', false), /server\.conf$/);
  assert.match(store.configPath('client', 'dshwg0', false), /client\.conf$/);
});
