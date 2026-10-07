/**
 * Scope checking — middleware factory.
 *
 * Wildcards: a key holding `crm:*` satisfies `crm:read`, `crm:write`, etc.
 * The reserved `*` scope satisfies every check — except a named-only scope.
 */

import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types';
import { error } from './response';

/**
 * Scopes a key only holds when they were granted by name. Neither `*` nor
 * `<namespace>:*` covers them: sending mail goes out under the workspace's
 * name to people outside it, so it is never a side effect of a broad grant.
 */
export const NAMED_ONLY_SCOPES: ReadonlySet<string> = new Set(['mail_messages:send']);

export function hasScope(scopes: readonly string[], required: string): boolean {
  if (scopes.includes(required)) return true;
  if (NAMED_ONLY_SCOPES.has(required)) return false;
  if (scopes.includes('*')) return true;
  const [namespace] = required.split(':');
  if (namespace && scopes.includes(`${namespace}:*`)) return true;
  return false;
}

export function requireScope(required: string): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const session = c.get('apiSession');
    if (!session) return error.unauthorized(c);
    if (!hasScope(session.scopes, required)) {
      return error.forbidden(c, `Missing required scope: ${required}`);
    }
    await next();
  };
}
