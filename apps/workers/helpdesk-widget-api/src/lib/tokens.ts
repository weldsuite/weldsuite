/**
 * HS256 JWTs: the realtime room tokens, the visitor tokens this worker
 * issues, and the identity tokens a customer's server signs for the widget.
 * WebCrypto only, so it runs on Workers and in tests alike.
 */

export type JwtClaims = Record<string, unknown>;

const encoder = new TextEncoder();

export function base64Url(input: string | ArrayBuffer | Uint8Array): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') bytes = encoder.encode(input);
  else if (input instanceof Uint8Array) bytes = input;
  else bytes = new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
}

function fromBase64Url(input: string): Uint8Array | null {
  if (!/^[\w-]*$/.test(input)) return null;
  try {
    const padded = input.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (input.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (ch) => ch.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signJwt(secret: string, claims: JwtClaims): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(claims));
  const key = await hmacKey(secret, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
  return `${header}.${body}.${base64Url(signature)}`;
}

export type JwtFailure = 'malformed' | 'algorithm' | 'signature' | 'expired' | 'not_yet_valid';

export type JwtResult = { ok: true; claims: JwtClaims } | { ok: false; reason: JwtFailure };

/**
 * Check an HS256 JWT: shape, `alg`, the signature (constant time, through
 * WebCrypto's verify), then `exp` and `nbf` with a minute of clock skew.
 */
export async function verifyJwt(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<JwtResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [rawHeader = '', rawBody = '', rawSignature = ''] = parts;
  const headerBytes = fromBase64Url(rawHeader);
  const bodyBytes = fromBase64Url(rawBody);
  const signature = fromBase64Url(rawSignature);
  if (!headerBytes || !bodyBytes || !signature) return { ok: false, reason: 'malformed' };

  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
    claims = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!header || typeof header !== 'object' || (header as { alg?: unknown }).alg !== 'HS256') {
    return { ok: false, reason: 'algorithm' };
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { ok: false, reason: 'malformed' };

  const key = await hmacKey(secret, 'verify');
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${rawHeader}.${rawBody}`));
  if (!valid) return { ok: false, reason: 'signature' };

  const skew = 60;
  const { exp, nbf } = claims as { exp?: unknown; nbf?: unknown };
  if (typeof exp === 'number' && exp + skew < nowSeconds) return { ok: false, reason: 'expired' };
  if (typeof nbf === 'number' && nbf - skew > nowSeconds) return { ok: false, reason: 'not_yet_valid' };
  return { ok: true, claims: claims as JwtClaims };
}

/**
 * A key for one purpose, derived from a worker secret (HMAC of the label).
 * Visitor tokens use their own key, so realtime-worker, which trusts tokens
 * signed with WIDGET_TOKEN_SECRET itself, can never accept one.
 */
export async function deriveSecret(secret: string, label: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  return base64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(label)));
}

