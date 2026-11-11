import assert from 'node:assert/strict';
import test from 'node:test';
import { generateJoinCode, secretsMatch } from '../../src/wireguard/lib/access';

test('generated join codes are random and usable as credentials', () => {
  const first = generateJoinCode();
  const second = generateJoinCode();
  assert.match(first, /^[A-Za-z0-9_-]{12}$/);
  assert.notEqual(first, second);
  assert.equal(secretsMatch(first, first), true);
  assert.equal(secretsMatch(second, first), false);
});

test('missing or malformed credentials never match', () => {
  assert.equal(secretsMatch('', ''), false);
  assert.equal(secretsMatch('anything', ''), false);
  assert.equal(secretsMatch('', 'anything'), false);
});
