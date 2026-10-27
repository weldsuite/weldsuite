/**
 * Widget Authentication Middleware
 *
 * widgetId header → master widget_registry → tenant desk_widget_settings.
 */

import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { getMasterDb, getTenantDbForWorkspace, schema, masterSchema } from '../db';

/**
 * Reduce an allowlist entry to a bare lowercase hostname. The setting is meant to
 * hold domains (`example.com`), but is written through the API by hand, so a
 * scheme, port, path, wildcard or capital letters are tolerated instead of
 * silently never matching.
 */
function normalizeAllowedDomain(entry: string): string {
  const withoutScheme = entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z\d+.-]*:\/\//, '');
  // Cut at the first path, query or fragment character (a plain search, no backtracking).
  const end = withoutScheme.search(/[/?#]/);
  const hostAndPort = end === -1 ? withoutScheme : withoutScheme.slice(0, end);
  return hostAndPort.replace(/:\d+$/, '').replace(/^\*?\./, '');
}

/** True when the request Origin's host equals, or is a subdomain of, an allowed domain. */
function isOriginAllowed(origin: string, allowedDomains: string[]): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    host = origin.toLowerCase();
  }
  return allowedDomains.some((entry) => {
    const d = normalizeAllowedDomain(entry);
    return d !== '' && (host === d || host.endsWith(`.${d}`));
  });
}

/** Whether the workspace's plan removes widget branding (false when no plan is set). */
async function loadRemoveBranding(
  masterDb: ReturnType<typeof getMasterDb>,
  planId: string | null,
): Promise<boolean> {
  if (!planId) return false;
  const { plans } = masterSchema;
  const planResults = await masterDb
    .select({ removeBranding: plans.removeBranding })
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  return planResults.length > 0 ? planResults[0].removeBranding : false;
}

export function widgetAuthMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(
    async (c, next) => {
      const widgetId = c.req.header('x-widget-id');

      if (!widgetId) {
        return c.json(
          { success: false, error: { code: 'UNAUTHORIZED', message: 'Missing x-widget-id header' } },
          401,
        );
      }

      try {
        const masterDb = getMasterDb(c.env);
        const { widgetRegistry, workspaces } = masterSchema;

        const registryResults = await masterDb
          .select({
            workspaceId: widgetRegistry.workspaceId,
            isActive: widgetRegistry.isActive,
          })
          .from(widgetRegistry)
          .where(eq(widgetRegistry.widgetId, widgetId))
          .limit(1);

        if (registryResults.length === 0) {
          return c.json(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid widget ID' } },
            401,
          );
        }

        const registryEntry = registryResults[0];
        if (!registryEntry.isActive) {
          return c.json(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Widget is inactive' } },
            401,
          );
        }

        const internalWorkspaceId = registryEntry.workspaceId;

        const workspaceResults = await masterDb
          .select({
            clerkOrgId: workspaces.clerkOrgId,
            planId: workspaces.planId,
          })
          .from(workspaces)
          .where(eq(workspaces.id, internalWorkspaceId))
          .limit(1);

        if (workspaceResults.length === 0 || !workspaceResults[0].clerkOrgId) {
          return c.json(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Workspace configuration not found' } },
            401,
          );
        }

        const clerkOrgId = workspaceResults[0].clerkOrgId;

        const removeBranding = await loadRemoveBranding(masterDb, workspaceResults[0].planId);

        const tenantDb = await getTenantDbForWorkspace(c.env, clerkOrgId);
        const { deskWidgetSettings } = schema;

        const configResults = await tenantDb
          .select()
          .from(deskWidgetSettings)
          .where(eq(deskWidgetSettings.widgetId, widgetId))
          .limit(1);

        if (configResults.length === 0) {
          return c.json(
            { success: false, error: { code: 'UNAUTHORIZED', message: 'Widget configuration not found' } },
            401,
          );
        }

        const widgetConfig = configResults[0];
        if (!widgetConfig.enabled) {
          return c.json(
            { success: false, error: { code: 'FORBIDDEN', message: 'Widget is disabled' } },
            403,
          );
        }

        // Allowed-domains policy. Every legitimate caller is a browser making a
        // cross-origin CORS fetch (the widget iframe runs on the widget host, this API
        // on its own host), and a browser always sends `Origin` on those, GET
        // included. So once a workspace has configured an allowlist, a request
        // without `Origin` is a non-browser client and is refused too; skipping the
        // check for it would let any script ignore the allowlist by omitting the header.
        // (`/webhook/discord` and `/health` are mounted outside this middleware, and
        // attachments are fetched from the public R2 URL, never through this API.)
        const allowed = widgetConfig.allowedDomains ?? [];
        if (allowed.length > 0) {
          const origin = c.req.header('Origin');
          if (!origin) {
            return c.json(
              { success: false, error: { code: 'FORBIDDEN', message: 'Origin header required' } },
              403,
            );
          }
          if (!isOriginAllowed(origin, allowed)) {
            return c.json(
              { success: false, error: { code: 'FORBIDDEN', message: 'Origin not allowed' } },
              403,
            );
          }
        }

        c.set('widgetId', widgetId);
        c.set('workspaceId', internalWorkspaceId);
        c.set('clerkOrgId', clerkOrgId);
        c.set('widgetConfig', widgetConfig);
        c.set('tenantDb', tenantDb);
        c.set('removeBranding', removeBranding);

        await next();
      } catch (err) {
        console.error('[Widget Auth] Database error:', err);
        return c.json(
          { success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to authenticate widget' } },
          500,
        );
      }
    },
  );
}
