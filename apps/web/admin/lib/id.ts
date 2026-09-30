export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
  return `${prefix}_${timestamp}${random}`;
}
