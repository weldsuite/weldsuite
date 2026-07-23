import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types';
import { createTenantDb } from '../db';
import { error } from '../lib/response';

/**
 * Builds a per-request Drizzle client from `session.databaseUrl` and stashes
 * it on `c.set('tenantDb', db)`. Must run after `authMiddleware`.
 */
export const tenantDbMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const session = c.get('apiSession');
  if (!session) return error.unauthorized(c);
  if (!session.databaseUrl) {
    return error.internal(c, `No database URL configured for workspace ${session.workspaceId}`);
  }
  const db = createTenantDb(session.databaseUrl);
  c.set('tenantDb', db);
  await next();
};
