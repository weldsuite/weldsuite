/**
 * Scope checking — middleware factory.
 *
 * This is the one file in `src/api/` that intentionally diverges from its
 * external-api origin. There, `requireScope` compared the literal scope against
 * an API key's scope list. Here there are no API keys: `apiSession.scopes`
 * holds the caller's **effective WeldSuite permissions**, resolved from their
 * workspace role, teams and per-member grants.
 *
 * The route files still call `requireScope('leads:write')` unchanged — the
 * translation from that coarse scope to a concrete `leads:create` /
 * `leads:update` / `leads:delete` check happens here, keyed on the request's
 * HTTP method. See `src/lib/permissions.ts` for the mapping and why `delete`
 * is never satisfied by a create-only grant.
 */

import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types';
import { canPerform, canUseScope } from '../../lib/permissions';
import { error } from './response';

/** Capability check without the middleware wrapper. */
export function hasScope(permissions: readonly string[], required: string): boolean {
  return canUseScope(permissions, required);
}

export function requireScope(required: string): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const session = c.get('apiSession');
    if (!session) return error.unauthorized(c);

    if (!canPerform(session.scopes, required, c.req.method)) {
      return error.forbidden(c, `Missing required permission for: ${required}`);
    }

    await next();
  };
}
