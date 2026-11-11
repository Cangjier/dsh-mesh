import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair, keyFingerprint, normalizeKey, publicKeyFromPrivate } from '../../src/wireguard/lib/keys';

test('generates compatible X25519 WireGuard keys', () => {
  const pair = generateKeyPair();
  assert.equal(pair.privateKey.length, 44);
  assert.equal(pair.publicKey.length, 44);
  assert.ok(normalizeKey(pair.privateKey));
  assert.ok(normalizeKey(pair.publicKey));
  assert.equal(publicKeyFromPrivate(pair.privateKey), pair.publicKey);
});

test('rejects keys with the wrong decoded length or alphabet', () => {
  assert.equal(normalizeKey('not-a-key'), null);
  assert.equal(normalizeKey(Buffer.alloc(31).toString('base64')), null);
  assert.equal(normalizeKey(Buffer.alloc(32).toString('base64')), Buffer.alloc(32).toString('base64'));
});

test('fingerprints never reveal the full key', () => {
  const pair = generateKeyPair();
  const fingerprint = keyFingerprint(pair.publicKey);
  assert.ok(fingerprint.includes('…'));
  assert.ok(!fingerprint.includes(pair.publicKey));
});
