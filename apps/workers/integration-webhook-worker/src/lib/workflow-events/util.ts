/**
 * Shared signature helpers for inbound integration webhooks (Web Crypto).
 */

export function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(buf: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function hmac(
  hash: 'SHA-1' | 'SHA-256',
  secret: string,
  data: string,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
}
