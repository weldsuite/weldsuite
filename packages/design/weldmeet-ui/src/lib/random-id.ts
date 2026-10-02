/**
 * Short random base-36 suffix for optimistic placeholder ids, drawn from the
 * Web Crypto CSPRNG (not Math.random).
 */
export function randomIdSuffix(length = 6): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
}
