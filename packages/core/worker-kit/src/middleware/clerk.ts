/**
 * Clerk JWT verification for every API worker (Bearer token from the
 * platform, mobile apps and portals). Sets userId, orgId and sessionId.
 */

import { createMiddleware } from 'hono/factory';
import { verifyToken } from '@clerk/backend';
import type { KitEnv } from '../env';

type AuthVariables = {
  userId: string;
  orgId: string | null;
  sessionId: string;
  factorVerificationAge?: readonly [number, number] | null;
};

const isFactorAge = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= -1;

/** Clerk's `fva` claim, `[first factor age, second factor age]` in minutes, when it is well formed. */
export function parseFactorVerificationAge(fva: unknown): readonly [number, number] | null {
  if (!Array.isArray(fva) || fva.length !== 2 || !isFactorAge(fva[0]) || !isFactorAge(fva[1])) return null;
  return [fva[0], fva[1]];
}

export const clerkMiddleware = () => {
  return createMiddleware<{ Bindings: KitEnv; Variables: AuthVariables }>(async (c, next) => {
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
        fva?: unknown;
      };
      const orgId = claims.o?.id || claims.org_id || null;

      c.set('userId', payload.sub);
      c.set('orgId', orgId);
      c.set('sessionId', claims.sid || '');
      c.set('factorVerificationAge', parseFactorVerificationAge(claims.fva));

      await next();
    } catch (err) {
      console.error('Clerk auth error:', err);
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } }, 401);
    }
  });
};
