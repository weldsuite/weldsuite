/** Cryptographically secure random base36 string of the given length. */
function randomSuffix(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/**
 * ID generation — same pattern as widget-api.
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = randomSuffix(8);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
