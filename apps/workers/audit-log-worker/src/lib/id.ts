/**
 * ID Generation Utility
 */

/** `length` random base36 characters from the Web Crypto RNG. */
function randomBase36(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = randomBase36(8);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
