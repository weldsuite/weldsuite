/**
 * HMAC tokens for Telnyx AI Assistant webhook tools.
 *
 * Call-control webhooks use Telnyx Ed25519 signatures. Tool invocations are
 * ordinary HTTPS POSTs from Telnyx Inference and do not carry those headers,
 * so we mint a short-lived Bearer token when the assistant is created / when
 * a call starts, and verify it on `/public/webhooks/telnyx/tools/*`.
 */

export interface DeskPhoneToolClaims {
  v: 1;
  org: string;
  aid: string;
  call?: string;
  conv?: string;
  exp: number;
}

const TOKEN_TTL_SECONDS = 24 * 60 * 60;

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function signDeskPhoneToolToken(
  secret: string,
  claims: Omit<DeskPhoneToolClaims, 'v' | 'exp'> & { exp?: number },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: DeskPhoneToolClaims = {
    v: 1,
    org: claims.org,
    aid: claims.aid,
    exp: claims.exp ?? nowSeconds + TOKEN_TTL_SECONDS,
    ...(claims.call ? { call: claims.call } : {}),
    ...(claims.conv ? { conv: claims.conv } : {}),
  };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = base64UrlEncode(await hmacSha256(secret, body));
  return `${body}.${sig}`;
}

export async function verifyDeskPhoneToolToken(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<DeskPhoneToolClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sigB64] = parts;
  let expected: Uint8Array;
  let given: Uint8Array;
  try {
    expected = await hmacSha256(secret, body);
    given = base64UrlDecode(sigB64);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, given)) return null;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as DeskPhoneToolClaims;
    if (parsed.v !== 1 || typeof parsed.org !== 'string' || typeof parsed.aid !== 'string') {
      return null;
    }
    if (typeof parsed.exp !== 'number' || parsed.exp < nowSeconds) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function bearerTokenFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}
