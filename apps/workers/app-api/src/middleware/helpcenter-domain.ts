/**
 * Help Center Domain Resolution Middleware
 *
 * Resolves an incoming help-center domain (the `?domain=` query param sent by
 * the public helpcenter Next app) to a workspace and its tenant database, with
 * a short-lived KV cache. Used by the unauthenticated /public/helpcenter/*
 * routes — these carry no Clerk JWT, so the tenant is resolved by domain
 * instead of by org.
 *
 *   1. Read `domain` query param
 *   2. Look up in master `helpcenterDomainRegistry` (active rows only)
 *   3. Cache the workspace → org mapping in KV (hc:{domain}, 5 min TTL)
 *   4. Resolve the tenant DB and set it on the context
 */

import { createMiddleware } from 'hono/factory';
import { and, eq } from 'drizzle-orm';
import type { Env, Variables } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../db';

const KV_TTL_SECONDS = 300; // 5 minutes

interface CachedDomainEntry {
  workspaceId: string;
  clerkOrgId: string;
}

export function helpcenterDomainMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const domain = c.req.query('domain');
    if (!domain) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing domain query parameter' } }, 400);
    }

    try {
      const cacheKey = `hc:${domain}`;
      let entry = (await c.env.WORKSPACE_CACHE.get(cacheKey, 'json')) as CachedDomainEntry | null;

      if (!entry) {
        const masterDb = getMasterDb(c.env);
        const [registry] = await masterDb
          .select({ workspaceId: masterSchema.helpcenterDomainRegistry.workspaceId })
          .from(masterSchema.helpcenterDomainRegistry)
          .where(
            and(
              eq(masterSchema.helpcenterDomainRegistry.domain, domain),
              eq(masterSchema.helpcenterDomainRegistry.isActive, 1),
            ),
          )
          .limit(1);

        if (!registry) {
          return c.json({ error: { code: 'NOT_FOUND', message: 'Help center not found for this domain' } }, 404);
        }

        const [workspace] = await masterDb
          .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
          .from(masterSchema.workspaces)
          .where(eq(masterSchema.workspaces.id, registry.workspaceId))
          .limit(1);

        if (!workspace?.clerkOrgId) {
          return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
        }

        entry = { workspaceId: registry.workspaceId, clerkOrgId: workspace.clerkOrgId };
        await c.env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });
      }

      const tenantDb = await getTenantDbForWorkspace(c.env, entry.clerkOrgId);
      c.set('tenantDb', tenantDb);
      c.set('workspaceId', entry.workspaceId);
      await next();
    } catch (err) {
      console.error('[app-api/helpcenter-domain] resolution error:', err);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve help center domain' } }, 500);
    }
  });
}
