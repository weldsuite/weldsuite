/**
 * Encoding helpers for the OIDC client: base64url, UTF-8, JWT payloads and
 * form bodies. Written out rather than relying on `atob`/`TextDecoder`, which
 * React Native's runtimes don't all provide.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP: Record<string, number> = Object.fromEntries([...ALPHABET].map((char, i) => [char, i]));

/** Bytes → base64url without padding (RFC 4648 §5). */
export function base64UrlFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    if (i + 1 < bytes.length) out += ALPHABET[(triple >> 6) & 63];
    if (i + 2 < bytes.length) out += ALPHABET[triple & 63];
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_');
}

/** Standard base64 (as `expo-crypto` returns digests) → base64url without padding. */
export function base64ToBase64Url(value: string): string {
  return value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** base64 or base64url (padding optional) → bytes. Null on invalid input. */
export function bytesFromBase64(value: string): Uint8Array | null {
  const clean = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (clean.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const v = LOOKUP[char];
    if (v === undefined) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** UTF-8 bytes → string. */
export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++] ?? 0;
    let code: number;
    if (b0 < 0x80) code = b0;
    else if (b0 >= 0xc0 && b0 < 0xe0) code = ((b0 & 0x1f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    else if (b0 >= 0xe0 && b0 < 0xf0) {
      code = ((b0 & 0x0f) << 12) | (((bytes[i++] ?? 0) & 0x3f) << 6) | ((bytes[i++] ?? 0) & 0x3f);
    } else {
      code =
        ((b0 & 0x07) << 18) |
        (((bytes[i++] ?? 0) & 0x3f) << 12) |
        (((bytes[i++] ?? 0) & 0x3f) << 6) |
        ((bytes[i++] ?? 0) & 0x3f);
    }
    out += String.fromCodePoint(code);
  }
  return out;
}

/** A JWT's payload, unverified (the backend verifies; the app only reads names and workspaces). */
export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  const bytes = bytesFromBase64(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(utf8Decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `application/x-www-form-urlencoded` body; undefined values are left out. */
export function formBody(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

/** URL with a query string; undefined values are left out. */
export function withQuery(url: string, params: Record<string, string | undefined>): string {
  const query = formBody(params);
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/** The query parameters of a redirect URL (`scheme://path?code=…&state=…`). */
export function queryParams(url: string): Record<string, string> {
  const query = url.split('#', 1)[0]?.split('?')[1] ?? '';
  const out: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [rawKey, rawValue = ''] = pair.split('=');
    try {
      out[decodeURIComponent(rawKey ?? '')] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      // A malformed pair is ignored.
    }
  }
  return out;
}
