/**
 * Resolve a tenant DB for the public B2B commerce portal from a workspace
 * slug. Mirrors helpcenter-domain middleware, but keyed by slug (no custom
 * domain in v1). Tests that already injected `tenantDb` skip the master lookup.
 */

import { createMiddleware } from 'hono/factory';
import { eq, like, desc } from 'drizzle-orm';
import type { Env, Variables } from '../types';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../db';

const KV_TTL_SECONDS = 300;

interface CachedSlugEntry {
  workspaceId: string;
  clerkOrgId: string;
}

function readSlug(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string | undefined {
  return c.req.query('slug') || c.req.header('X-Workspace-Slug') || undefined;
}

export function commercePortalSlugMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    // Test harness (and any caller that already resolved a tenant) skips master.
    if (c.get('tenantDb')) {
      await next();
      return;
    }

    const slug = readSlug(c)?.trim();
    if (!slug) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing workspace slug' } }, 400);
    }

    try {
      const cacheKey = `cportal:slug:${slug.toLowerCase()}`;
      let entry = (await c.env.WORKSPACE_CACHE.get(cacheKey, 'json')) as CachedSlugEntry | null;

      if (!entry) {
        const masterDb = getMasterDb(c.env);
        let [workspace] = await masterDb
          .select({
            id: masterSchema.workspaces.id,
            clerkOrgId: masterSchema.workspaces.clerkOrgId,
            slug: masterSchema.workspaces.slug,
            isActive: masterSchema.workspaces.isActive,
          })
          .from(masterSchema.workspaces)
          .where(eq(masterSchema.workspaces.slug, slug))
          .limit(1);

        if (!workspace) {
          [workspace] = await masterDb
            .select({
              id: masterSchema.workspaces.id,
              clerkOrgId: masterSchema.workspaces.clerkOrgId,
              slug: masterSchema.workspaces.slug,
              isActive: masterSchema.workspaces.isActive,
            })
            .from(masterSchema.workspaces)
            .where(like(masterSchema.workspaces.slug, `${slug}-%`))
            .orderBy(desc(masterSchema.workspaces.createdAt))
            .limit(1);
        }

        if (!workspace || !workspace.isActive || !workspace.clerkOrgId) {
          return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
        }

        entry = { workspaceId: workspace.id, clerkOrgId: workspace.clerkOrgId };
        await c.env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });
      }

      const tenantDb = await getTenantDbForWorkspace(c.env, entry.clerkOrgId);
      c.set('tenantDb', tenantDb);
      c.set('workspaceId', entry.workspaceId);
      await next();
    } catch (err) {
      console.error('[app-api/commerce-portal-slug] resolution error:', err);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve workspace' } }, 500);
    }
  });
}
