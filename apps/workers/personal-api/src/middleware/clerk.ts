/**
 * Clerk JWT verification — adapted from app-api (user only; org ignored).
 * Also resolves Clerk Billing entitlements from session claims.
 */

import { createMiddleware } from 'hono/factory';
import { verifyToken } from '@clerk/backend';
import { entitlementsFromClerkClaims, FREE_ENTITLEMENTS } from '../lib/billing';
import type { Env, Variables } from '../types';

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
      const payload = await verifyToken(token, {
        secretKey: c.env.CLERK_SECRET_KEY,
        ...(c.env.CLERK_JWT_KEY ? { jwtKey: c.env.CLERK_JWT_KEY } : {}),
      });

      if (!payload.sub) {
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token payload' } }, 401);
      }

      const claims = payload as typeof payload & {
        sid?: string;
      };

      c.set('userId', payload.sub);
      c.set('sessionId', claims.sid || '');
      c.set(
        'entitlements',
        entitlementsFromClerkClaims(payload as unknown as Record<string, unknown>),
      );

      await next();
    } catch (err) {
      console.error('Clerk auth error:', err);
      // Ensure entitlements always exist for downstream handlers that might run
      // before a hard failure — not reached on throw, but safe default on partial set.
      c.set('entitlements', FREE_ENTITLEMENTS);
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } }, 401);
    }
  });
};
