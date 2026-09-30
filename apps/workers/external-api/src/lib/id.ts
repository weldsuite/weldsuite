/** Cryptographically secure random base36 string of the given length. */
export function randomSuffix(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36);
  const random = randomSuffix(8);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}
