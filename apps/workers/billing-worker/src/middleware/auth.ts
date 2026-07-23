/**
 * Auth Middleware for Billing Worker
 *
 * Verifies Clerk JWT tokens for API routes.
 * Extracts userId and orgId from the JWT claims.
 */

import { createMiddleware } from 'hono/factory';
import type { Env } from '../index';

interface JwtPayload {
  sub: string;
  org_id?: string;
  org_slug?: string;
  /** Clerk org role, e.g. "org:admin" or "org:member". Absent outside an org. */
  org_role?: string;
  iat?: number;
  exp?: number;
}

/**
 * Clerk JWT authentication middleware.
 * Verifies the Bearer token using the CLERK_JWT_KEY (SPKI public key).
 */
export const clerkJwtAuth = () => {
  return createMiddleware<{
    Bindings: Env;
    Variables: {
      userId: string;
      orgId: string | null;
      orgRole: string | null;
    };
  }>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const token = authHeader.slice(7);
    const jwtKey = c.env.CLERK_JWT_KEY;

    if (!jwtKey) {
      console.error('[Billing Worker] CLERK_JWT_KEY not configured');
      return c.json({ error: 'Auth not configured' }, 500);
    }

    try {
      const payload = await verifyClerkJwt(token, jwtKey);

      if (!payload.sub) {
        return c.json({ error: 'Invalid token: missing subject' }, 401);
      }

      c.set('userId', payload.sub);
      c.set('orgId', payload.org_id || null);
      c.set('orgRole', payload.org_role || null);

      await next();
    } catch (err: any) {
      console.error('[Billing Worker] JWT verification failed:', err.message);
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  });
};

/**
 * Guard for routes that commit the workspace to recurring charges. Follows
 * after `clerkJwtAuth`. Clerk sets `org_role` to e.g. "org:admin" /
 * "org:member" for workspace admins; anything else is denied.
 */
export const requireOrgAdmin = () => {
  return createMiddleware<{
    Bindings: Env;
    Variables: { userId: string; orgId: string | null; orgRole: string | null };
  }>(async (c, next) => {
    const role = c.get('orgRole');
    if (role !== 'org:admin') {
      return c.json(
        { error: 'Only workspace admins can change billing.' },
        403,
      );
    }
    await next();
  });
};

/**
 * Verify a Clerk JWT using Web Crypto API with the SPKI public key.
 */
async function verifyClerkJwt(token: string, pemKey: string): Promise<JwtPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Parse header to get algorithm
  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  // Import the public key
  const keyData = pemToArrayBuffer(pemKey);
  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Verify signature
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToArrayBuffer(signatureB64);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    data
  );

  if (!valid) {
    throw new Error('Invalid JWT signature');
  }

  // Decode payload
  const payload: JwtPayload = JSON.parse(
    atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))
  );

  // Check expiration
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
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
