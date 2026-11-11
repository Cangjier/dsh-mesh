/** WireGuard Curve25519 keys generated and derived with Node's built-in crypto. */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * Convert a base64url value (JWK) into standard padded base64.
 * @param {string} value base64url text.
 * @returns {string} standard base64.
 */
function base64urlToBase64(value) {
  return value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
}

/**
 * PKCS#8 header for a raw X25519 private key (RFC 8410).
 * The complete DER value is this prefix followed by the 32 key bytes.
 */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/**
 * Normalize and validate a WireGuard key.
 * @param {unknown} value candidate key.
 * @returns {string | null} canonical base64 key, or null.
 */
export function normalizeKey(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (/^[A-Za-z0-9+/]{43}$/.test(text)) text += '=';
  if (!KEY_PATTERN.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== 32) return null;
  return bytes.toString('base64');
}

/**
 * Generate a fresh WireGuard private/public key pair.
 * @returns {{ privateKey: string, publicKey: string }} base64 keys.
 */
export function generateKeyPair() {
  const pair = generateKeyPairSync('x25519');
  const privateJwk = pair.privateKey.export({ format: 'jwk' });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  return {
    privateKey: base64urlToBase64(privateJwk.d),
    publicKey: base64urlToBase64(publicJwk.x),
  };
}

/**
 * Derive the public key for a stored private key.
 * @param {string} privateKey base64 private key.
 * @returns {string} base64 public key.
 */
export function publicKeyFromPrivate(privateKey) {
  const normalized = normalizeKey(privateKey);
  if (!normalized) throw new Error('Invalid WireGuard private key');
  const raw = Buffer.from(normalized, 'base64');
  const key = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicJwk = createPublicKey(key).export({ format: 'jwk' });
  return base64urlToBase64(publicJwk.x);
}

/**
 * Short, non-secret visual fingerprint for a public key.
 * @param {string} publicKey base64 public key.
 * @returns {string} 6+6 character fingerprint.
 */
export function keyFingerprint(publicKey) {
  const normalized = normalizeKey(publicKey);
  if (!normalized) return '';
  return `${normalized.slice(0, 6)}…${normalized.slice(-6)}`;
}
