/** SHA-256 as lowercase hex, for document fingerprints and link tokens. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const encoder = new TextEncoder();

/** HMAC-SHA-256 as lowercase hex. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The stored form of a signer's code (an access code, or an emailed one):
 * HMAC keyed with the worker secret and bound to the recipient. Codes are
 * short, so a plain hash would fall to a brute force by anyone who can read
 * the database or a backup; without the secret this one cannot be tried.
 */
export function codeHash(secret: string, recipientId: string, code: string): Promise<string> {
  return hmacHex(secret, `sign-code:${recipientId}:${code.trim()}`);
}
