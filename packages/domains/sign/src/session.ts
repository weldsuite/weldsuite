/**
 * Signer sessions: what the portal sends as a bearer token after a link (and
 * its code, when one is required) was checked. HMAC-SHA-256 over a small JSON
 * payload, bound to one recipient of one envelope in one workspace, valid two
 * hours. The portal keeps it in an httpOnly cookie.
 */

import { base64Url } from './hash';

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export interface SignerSession {
  /** Clerk org id of the workspace. */
  orgId: string;
  envelopeId: string;
  recipientId: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

const encoder = new TextEncoder();

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(secret: string, session: Omit<SignerSession, 'exp'>, now = Date.now()): Promise<{ token: string; expiresAt: Date }> {
  const payload: SignerSession = { ...session, exp: now + SESSION_TTL_MS };
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body)));
  return { token: `${body}.${base64Url(sig)}`, expiresAt: new Date(payload.exp) };
}

/** The session in a bearer token, or null when it is malformed, forged or expired. */
export async function verifySession(secret: string, token: string, now = Date.now()): Promise<SignerSession | null> {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), encoder.encode(body));
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SignerSession;
    if (typeof session.exp !== 'number' || session.exp < now) return null;
    if (!session.orgId || !session.envelopeId || !session.recipientId) return null;
    return session;
  } catch {
    return null;
  }
}
