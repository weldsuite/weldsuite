/**
 * Resolve a tenant DB for the public B2B commerce portal from a workspace
 * slug. Mirrors helpcenter-domain middleware, but keyed by slug (no custom
 * domain in v1). Tests that already injected `tenantDb` skip the master lookup.
 *
 * The slug comes straight from an unauthenticated request (`?slug=` or
 * `X-Workspace-Slug`), so it is validated before it touches the KV cache key or
 * the master DB, and it is matched EXACTLY. There is deliberately no prefix
 * ("{slug}-*") fallback: it let `?slug=%` resolve the newest tenant and `a%`,
 * `b%`, ... enumerate every slug, and even without wildcards it could answer
 * with the wrong tenant.
 */

import type { Next } from 'hono';
import { eq } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '@weldsuite/worker-kit/db';
import type { Database, DbEnv } from '@weldsuite/worker-kit/env';

/** The context variables this middleware sets (a subset of every API worker's). */
export type PortalSlugVariables = {
  tenantDb: Database;
  workspaceId: string;
  orgId: string | null;
};

/**
 * The slice of a Hono context this middleware touches. Any worker's
 * `Context<{ Bindings: Env; Variables: Variables }>` fits when its Env includes
 * DbEnv and its Variables include {@link PortalSlugVariables}, so commerce-api
 * (the commerce portal) and hr-api (the workforce portal) share one middleware.
 */
export interface PortalSlugContext {
  req: { query(key: string): string | undefined; header(name: string): string | undefined };
  env: DbEnv;
  get(key: 'tenantDb'): Database | undefined;
  set(key: 'tenantDb', value: PortalSlugVariables['tenantDb']): void;
  set(key: 'workspaceId', value: PortalSlugVariables['workspaceId']): void;
  set(key: 'orgId', value: PortalSlugVariables['orgId']): void;
  json(body: { error: { code: string; message: string } }, status: 400 | 404 | 500): Response;
}

const KV_TTL_SECONDS = 300;

/**
 * What a portal request may call a workspace: lowercase letters, digits and
 * hyphens. Workspace slugs are created lowercase (`slugifyWorkspaceName`,
 * the `updateWorkspaceSlugInput` rule `^[a-z][a-z0-9-]{1,61}[a-z0-9]$`, and
 * Clerk org slugs), with an optional collision suffix of `-<6 chars>` or
 * `-<6 chars>-<n>` appended, so 100 characters is generous headroom. The
 * lookup stays an exact match, so this pattern is deliberately a little wider
 * than the creation rule: a stricter check would lock out a legacy slug, a
 * looser one would only let junk into the cache key and the master DB.
 */
export const PORTAL_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;

/**
 * Trim, lowercase and validate a slug taken from a request. Returns null when
 * it is missing or not shaped like a workspace slug (`%`, `_`, `\`, `.`,
 * whitespace, unicode, over-long values, ...).
 */
export function normalizePortalSlug(raw: string | null | undefined): string | null {
  const slug = raw?.trim().toLowerCase();
  return slug && PORTAL_SLUG_PATTERN.test(slug) ? slug : null;
}

function readRawSlug(c: Pick<PortalSlugContext, 'req'>): string | undefined {
  return c.req.query('slug') || c.req.header('X-Workspace-Slug') || undefined;
}

/**
 * The validated, lowercased workspace slug of this request, or null. Handlers
 * that need the slug (e.g. to build a link in an email) must use this instead
 * of re-reading the raw query / header.
 */
export function readPortalSlug(c: Pick<PortalSlugContext, 'req'>): string | null {
  return normalizePortalSlug(readRawSlug(c));
}

interface CachedSlugEntry {
  workspaceId: string;
  clerkOrgId: string;
}

export function commercePortalSlugMiddleware() {
  return async (c: PortalSlugContext, next: Next): Promise<Response | void> => {
    // Test harness (and any caller that already resolved a tenant) skips master.
    if (c.get('tenantDb')) {
      await next();
      return;
    }

    const rawSlug = readRawSlug(c)?.trim();
    if (!rawSlug) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing workspace slug' } }, 400);
    }
    const slug = normalizePortalSlug(rawSlug);
    if (!slug) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid workspace slug' } }, 400);
    }

    try {
      const cacheKey = `cportal:slug:${slug}`;
      let entry = (await c.env.WORKSPACE_CACHE.get(cacheKey, 'json')) as CachedSlugEntry | null;

      if (!entry) {
        const masterDb = getMasterDb(c.env);
        const [workspace] = await masterDb
          .select({
            id: masterSchema.workspaces.id,
            clerkOrgId: masterSchema.workspaces.clerkOrgId,
            isActive: masterSchema.workspaces.isActive,
          })
          .from(masterSchema.workspaces)
          .where(eq(masterSchema.workspaces.slug, slug))
          .limit(1);

        if (!workspace?.isActive || !workspace.clerkOrgId) {
          return c.json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } }, 404);
        }

        entry = { workspaceId: workspace.id, clerkOrgId: workspace.clerkOrgId };
        await c.env.WORKSPACE_CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });
      }

      const tenantDb = await getTenantDbForWorkspace(c.env, entry.clerkOrgId);
      c.set('tenantDb', tenantDb);
      c.set('workspaceId', entry.workspaceId);
      // Clerk-authenticated routes key everything workspace-scoped (entity
      // events, realtime hubs) by the Clerk org id. Expose it so a public
      // router that publishes can use the same key.
      c.set('orgId', entry.clerkOrgId);
      await next();
    } catch (err) {
      console.error('[commerce-domain/portal-slug] resolution error:', err);
      return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve workspace' } }, 500);
    }
  };
}
