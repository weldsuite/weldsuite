/**
 * Scope checking — middleware factory.
 *
 * Wildcards: a key holding `crm:*` satisfies `crm:read`, `crm:write`, etc.
 * The reserved `*` scope satisfies every check.
 */

import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types';
import { error } from './response';

export function hasScope(scopes: readonly string[], required: string): boolean {
  if (scopes.includes('*')) return true;
  if (scopes.includes(required)) return true;
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
