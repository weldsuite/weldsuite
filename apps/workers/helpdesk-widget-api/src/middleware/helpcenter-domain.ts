/**
 * Help-center tenant resolution for `/api/portal/*`: the `?domain=` the help
 * center sends (from the reader's Host) → master `helpcenter_domain_registry`
 * (active rows) → workspace → tenant DB. The same lookup as desk-api's
 * `/public/helpcenter` feed (ADR DESK-006), sharing its KV cache key.
 */

import { createMiddleware } from 'hono/factory';
import { and, eq } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '../db';
import { error } from '../lib/response';

const KV_TTL_SECONDS = 300;

interface CachedDomainEntry {
  workspaceId: string;
  clerkOrgId: string;
}

async function lookupDomain(env: Env, domain: string): Promise<CachedDomainEntry | null> {
  const cacheKey = `hc:${domain}`;
  const cached = (await env.WORKSPACE_CACHE.get(cacheKey, 'json')) as CachedDomainEntry | null;
  if (cached) return cached;

  const masterDb = getMasterDb(env);
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
  if (!registry) return null;

  const [workspace] = await masterDb
    .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.id, registry.workspaceId))
    .limit(1);
  if (!workspace?.clerkOrgId) return null;

  const entry = { workspaceId: registry.workspaceId, clerkOrgId: workspace.clerkOrgId };
  await env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });
  return entry;
}

export function helpcenterDomainMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const domain = c.req.query('domain')?.trim().toLowerCase();
    if (!domain) return error.badRequest(c, 'Missing domain query parameter');
    try {
      const entry = await lookupDomain(c.env, domain);
      if (!entry) return error.notFound(c, 'Help center');
      c.set('tenantDb', await getTenantDbForWorkspace(c.env, entry.clerkOrgId));
      c.set('workspaceId', entry.workspaceId);
      c.set('clerkOrgId', entry.clerkOrgId);
    } catch (err) {
      console.error('[widget-api/helpcenter-domain] resolution error:', err);
      return error.internal(c, 'Failed to resolve help center domain');
    }
    await next();
  });
}
