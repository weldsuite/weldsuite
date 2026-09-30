/**
 * Short random base-36 suffix for correlation / local record ids, drawn from
 * the Web Crypto CSPRNG (not Math.random). These ids are not secrets, but
 * unpredictable values avoid collisions and keep static analysis quiet.
 */
export function randomIdSuffix(length = 8): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('');
}
