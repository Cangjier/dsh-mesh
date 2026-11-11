/** Shared join-code generation and constant-time comparison. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generate a random join code. The same value is used as the control-panel
 * password, so it must remain URL- and header-friendly.
 * @returns {string} 12-character base64url code.
 */
export function generateJoinCode(): string {
  return randomBytes(9).toString('base64url');
}

/**
 * Compare two secrets without leaking their contents through timing.
 * @param {string} supplied candidate value.
 * @param {string} expected stored value.
 * @returns {boolean} whether both values match.
 */
export function secretsMatch(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const left = createHash('sha256').update(supplied).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
