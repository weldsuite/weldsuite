import '@tanstack/react-start/server-only';

/**
 * Cookies only this server can read or write: AES-256-GCM over a JSON body,
 * with a key derived (HKDF-SHA-256) from `ADMIN_SESSION_SECRET` and the
 * cookie's name, which is also the additional data. So a changed byte, a value
 * moved from one cookie to another, or a cookie sealed with another secret
 * opens as nothing, never as someone else's session.
 *
 * Every sealed value carries its own expiry, checked on open, besides the
 * cookie's Max-Age (which a browser may ignore and a thief certainly will).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A secret too short to derive keys from is a configuration error, not a weak key. */
export const MIN_SECRET_LENGTH = 32;

const IV_BYTES = 12;

async function cookieKey(secret: string, name: string): Promise<CryptoKey> {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`ADMIN_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('weldsuite-admin-cookie'), info: encoder.encode(name) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
  let end = base64.length;
  while (end > 0 && base64[end - 1] === '=') end--;
  return base64.slice(0, end);
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Seal `data` for the cookie `name`, valid for `ttlSeconds` from `now`. */
export async function seal<T extends object>(
  secret: string,
  name: string,
  data: T,
  ttlSeconds: number,
  now = Date.now(),
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = encoder.encode(JSON.stringify({ data, exp: Math.floor(now / 1000) + ttlSeconds }));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(name) },
    await cookieKey(secret, name),
    body,
  );
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return toBase64Url(out);
}

/**
 * The data sealed in `value` for the cookie `name`, or null when it is
 * missing, malformed, tampered with, sealed for another cookie or secret, or
 * expired. Throws only when the secret itself is unusable.
 */
export async function open<T>(secret: string, name: string, value: string | undefined, now = Date.now()): Promise<T | null> {
  const key = await cookieKey(secret, name);
  if (!value) return null;
  const bytes = fromBase64Url(value);
  if (!bytes || bytes.length <= IV_BYTES) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(name) },
      key,
      bytes.slice(IV_BYTES),
    );
    const parsed = JSON.parse(decoder.decode(plain)) as { data?: T; exp?: unknown };
    if (typeof parsed.exp !== 'number' || parsed.exp <= Math.floor(now / 1000) || parsed.data === undefined) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** The value of cookie `name` in a `Cookie` header. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * A `Set-Cookie` value for a `__Host-` cookie: Secure, Path=/, no Domain (the
 * prefix makes browsers enforce all three), HttpOnly, SameSite=Lax (the
 * identity provider's redirect back is a top-level cross-site GET, which Lax
 * still sends). `maxAge` 0 deletes it.
 */
export function cookieHeader(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
