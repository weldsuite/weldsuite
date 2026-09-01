/**
 * Clerk JWT verification — adapted from app-api (user only; org ignored).
 * Also resolves Clerk Billing entitlements from session claims.
 *
 * `@clerk/backend` `verifyToken` is tried first. If that throws (stale PEM,
 * escaped newlines in wrangler secrets, JWKS fetch on Workers), fall back to
 * the same Web Crypto RS256 check billing-worker uses so a production Expo
 * session JWT still authenticates.
 */

import { createMiddleware } from 'hono/factory';
import { verifyToken } from '@clerk/backend';
import { entitlementsFromClerkClaims, FREE_ENTITLEMENTS } from '../lib/billing';
import type { Env, Variables } from '../types';

type ClerkJwtPayload = {
  sub?: string;
  sid?: string;
  exp?: number;
  [key: string]: unknown;
};

function formatClerkError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { reason?: string; message?: string; action?: string };
    const parts = [e.reason, e.message, e.action].filter(Boolean);
    if (parts.length > 0) return parts.join(' — ');
  }
  return err instanceof Error ? err.message : String(err);
}

function normalizePem(key: string): string {
  return key.replace(/\\n/g, '\n').replace(/\\r/g, '').trim();
}

function decodeJwtPayload(token: string): ClerkJwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(json) as ClerkJwtPayload;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = normalizePem(pem)
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Networkless RS256 verify — same approach as billing-worker. */
async function verifyClerkJwtLocal(token: string, pemKey: string): Promise<ClerkJwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'))) as { alg?: string };
  if (header.alg !== 'RS256') throw new Error(`Unsupported algorithm: ${header.alg}`);

  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(pemKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    base64UrlToArrayBuffer(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error('Invalid JWT signature');

  const payload = decodeJwtPayload(token);
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }
  return payload;
}

async function verifyClerkToken(token: string, env: Env): Promise<ClerkJwtPayload> {
  const secretKey = env.CLERK_SECRET_KEY;
  const jwtKey = env.CLERK_JWT_KEY ? normalizePem(env.CLERK_JWT_KEY) : undefined;
  const options = { secretKey, clockSkewInMs: 60_000 };

  if (jwtKey) {
    try {
      return (await verifyToken(token, { ...options, jwtKey })) as ClerkJwtPayload;
    } catch (err) {
      console.error('[personal-api] jwtKey verifyToken failed:', formatClerkError(err));
    }
  }

  try {
    return (await verifyToken(token, options)) as ClerkJwtPayload;
  } catch (err) {
    console.error('[personal-api] JWKS verifyToken failed:', formatClerkError(err));
    if (!jwtKey) throw err;
    return verifyClerkJwtLocal(token, jwtKey);
  }
}

export const clerkMiddleware = () => {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' } },
        401,
      );
    }

    const token = authHeader.slice(7);

    try {
      const payload = await verifyClerkToken(token, c.env);

      if (!payload.sub) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token payload' } }, 401);
      }

      c.set('userId', payload.sub);
      c.set('sessionId', (payload.sid as string | undefined) || '');
      c.set(
        'entitlements',
        entitlementsFromClerkClaims(payload as Record<string, unknown>),
      );

      await next();
    } catch (err) {
      console.error('Clerk auth error:', formatClerkError(err));
      c.set('entitlements', FREE_ENTITLEMENTS);
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } }, 401);
    }
  });
};
