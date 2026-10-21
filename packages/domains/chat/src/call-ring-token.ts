/**
 * WeldChat — signed ring tokens.
 *
 * An incoming-call push carries a token that lets that one recipient decline
 * that one ring without a session. The phone needs it when the user taps
 * Decline on the lock screen (Android) or in CallKit (iOS) while the app is
 * not running and has no Clerk session to call `/api/chat-calls/:id/decline`
 * with. chat-api's `/public/chat-calls/decline` accepts it instead.
 *
 * `<base64url(claims)>.<base64url(HMAC-SHA256(secret, claims))>`. The claims
 * name the Clerk org, the recipient and the call, and expire shortly after the
 * ring would have timed out anyway, so a leaked token can do nothing but
 * decline a call that is about to end.
 */

/** How long a ring token works. The phone's ring stops after 60s. */
export const CALL_RING_TOKEN_TTL_MS = 2 * 60_000;

export interface CallRingClaims {
  /** Clerk org id of the workspace (resolves the tenant DB). */
  orgId: string;
  /** The ringing recipient. */
  userId: string;
  callId: string;
}

interface EncodedClaims {
  o: string;
  u: string;
  c: string;
  /** Expiry, epoch ms. */
  e: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

export async function signCallRingToken(
  secret: string,
  claims: CallRingClaims,
  now = Date.now(),
): Promise<string> {
  const encoded: EncodedClaims = { o: claims.orgId, u: claims.userId, c: claims.callId, e: now + CALL_RING_TOKEN_TTL_MS };
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(encoded)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The token's claims when it is genuine and unexpired, else null. Never throws. */
export async function verifyCallRingToken(
  secret: string | undefined,
  token: string,
  now = Date.now(),
): Promise<CallRingClaims | null> {
  if (!secret) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const signature = fromBase64Url(sig);
  if (!signature) return null;
  try {
    // crypto.subtle.verify compares in constant time.
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      signature,
      new TextEncoder().encode(body),
    );
    if (!valid) return null;
    const raw = fromBase64Url(body);
    if (!raw) return null;
    const claims = JSON.parse(new TextDecoder().decode(raw)) as Partial<EncodedClaims>;
    if (typeof claims.o !== 'string' || typeof claims.u !== 'string' || typeof claims.c !== 'string') return null;
    if (typeof claims.e !== 'number' || claims.e < now) return null;
    return { orgId: claims.o, userId: claims.u, callId: claims.c };
  } catch {
    return null;
  }
}
