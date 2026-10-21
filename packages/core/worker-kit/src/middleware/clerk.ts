/**
 * Clerk JWT verification for every API worker (Bearer token from the
 * platform, mobile apps and portals). Sets userId, orgId and sessionId.
 *
 * After the signature check the token's authorized party (`azp`) must be a
 * first-party origin (`isAuthorizedParty` in ../cors, the same list CORS uses),
 * so a session token minted for another frontend on the same Clerk instance is
 * refused. Native apps mint tokens without an `azp` and pass. The check runs on
 * the verified payload rather than through Clerk's `authorizedParties` option
 * so that an empty claim is refused too and the rule is one shared helper.
 */

import { createMiddleware } from 'hono/factory';
import { verifyToken } from '@clerk/backend';
import { isAuthorizedParty, parseExtraAuthorizedParties } from '../cors';
import type { KitEnv } from '../env';

type AuthVariables = {
  userId: string;
  orgId: string | null;
  sessionId: string;
  factorVerificationAge?: readonly [number, number] | null;
};

type ClerkEnv = KitEnv & {
  /**
   * Optional comma-separated origins accepted as `azp` in addition to the
   * first-party list (see `parseExtraAuthorizedParties`), for example the
   * WeldPass extension's `chrome-extension://<id>`.
   */
  CLERK_AUTHORIZED_PARTIES?: string;
};

const isFactorAge = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= -1;

/** Clerk's `fva` claim, `[first factor age, second factor age]` in minutes, when it is well formed. */
export function parseFactorVerificationAge(fva: unknown): readonly [number, number] | null {
  if (!Array.isArray(fva) || fva.length !== 2 || !isFactorAge(fva[0]) || !isFactorAge(fva[1])) return null;
  return [fva[0], fva[1]];
}

export const clerkMiddleware = () => {
  return createMiddleware<{ Bindings: ClerkEnv; Variables: AuthVariables }>(async (c, next) => {
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

      if (!isAuthorizedParty(payload.azp, parseExtraAuthorizedParties(c.env.CLERK_AUTHORIZED_PARTIES))) {
        // The origin only, never the token. Truncated: the claim is client-influenced.
        console.warn(
          `Clerk auth: token refused, azp ${JSON.stringify(payload.azp).slice(0, 200)} is not an authorized party`,
        );
        return c.json({ error: { code: 'UNAUTHORIZED', message: 'Token verification failed' } }, 401);
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
