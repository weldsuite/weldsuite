/**
 * Cryptographically secure random id helpers (Web Crypto, available in the
 * browser and in the Node/Edge runtimes Next.js uses).
 */

/** Random base-36 string of `length` characters. */
export function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}
