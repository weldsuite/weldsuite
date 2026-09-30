/**
 * Cryptographically secure random helpers for non-security call sites
 * (client-generated ids, slug suffixes, animation jitter). Backed by
 * `crypto.getRandomValues` so no pseudorandom `Math.random` is involved.
 */

/** Secure replacement for `Math.random()`: a float in the range [0, 1). */
export function secureRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 0x100000000;
}

/** Random lowercase alphanumeric (base36) string of the given length. */
export function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
}
