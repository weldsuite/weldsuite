/**
 * Clerk JWT verification — copied from core-api for now; will move into a
 * shared @weldsuite/api-lib once a second object exists.
 */

import { createMiddleware } from 'hono/factory';
import { verifyToken } from '@clerk/backend';
import type { Env } from '../types';

type AuthVariables = {
  userId: string;
  orgId: string | null;
  sessionId: string;
};

export const clerkMiddleware = () => {
  return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
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

      // Clerk's typed JWT payload doesn't carry these v2-session claims;
      // narrow to the actual shape Clerk emits.
      const claims = payload as typeof payload & {
        o?: { id?: string };
        org_id?: string;
        sid?: string;
      };
      const orgId = claims.o?.id || claims.org_id || null;

      c.set('userId', payload.sub);
      c.set('orgId', orgId);
      c.set('sessionId', claims.sid || '');

      await next();
    } catch (err) {
      console.error('Clerk auth error:', err);
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } }, 401);
    }
  });
};
