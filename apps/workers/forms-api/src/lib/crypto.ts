/**
 * Small crypto helpers: hashes, HMACs and signed tokens. Web Crypto only, so
 * they run on Workers and in vitest alike.
 */

import { timingSafeEqualStr } from '@weldsuite/worker-kit';

const encoder = new TextEncoder();

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** HMAC-SHA-256 as lowercase hex. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqualStr(a, b);
}

/** `<base64url(json)>.<base64url(hmac)>`: a payload only the holder of `secret` can have made. */
export async function signToken(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body)));
  return `${body}.${base64Url(sig)}`;
}

/** The payload of a token `signToken` made, or null when it is malformed or forged. Expiry is the caller's to check. */
export async function verifyToken<T extends { exp: number }>(secret: string, token: string, now = Date.now()): Promise<T | null> {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(sig), encoder.encode(body));
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
