import type { MiddlewareHandler } from 'hono';
import { reindexWorkspaceDomainRenewals } from '@weldsuite/db/lib/domain-renewal-index';
import { getMasterDb } from '../db';
import type { Env, Variables } from '../types';

/**
 * After a successful write on a domain router, re-derive the workspace's
 * master `domain_renewal_index` row in the background, so the daily
 * auto-renew sweep only opens tenants with a renewal due.
 */
export function domainRenewalIndexMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    await next();
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.res.status >= 400) return;
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');
    if (!db || !workspaceId) return;
    c.executionCtx.waitUntil(
      (async () => {
        await reindexWorkspaceDomainRenewals(getMasterDb(c.env), db, workspaceId);
      })().catch((err) => console.warn('[domain-renewal-index] reindex failed:', err)),
    );
  };
}
