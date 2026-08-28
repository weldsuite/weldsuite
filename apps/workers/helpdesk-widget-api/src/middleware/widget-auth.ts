/**
 * Widget Authentication Middleware
 *
 * widgetId header → master widget_registry → tenant desk_widget_settings.
 */

import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { getMasterDb, getTenantDbForWorkspace, schema, masterSchema } from '../db';

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
        const { widgetRegistry, workspaces, plans } = masterSchema;

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

        let removeBranding = false;
        const { planId } = workspaceResults[0];
        if (planId) {
          const planResults = await masterDb
            .select({ removeBranding: plans.removeBranding })
            .from(plans)
            .where(eq(plans.id, planId))
            .limit(1);
          if (planResults.length > 0) {
            removeBranding = planResults[0].removeBranding;
          }
        }

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

        const origin = c.req.header('Origin');
        const allowed = widgetConfig.allowedDomains ?? [];
        if (origin && allowed.length > 0) {
          let host = '';
          try {
            host = new URL(origin).hostname;
          } catch {
            host = origin;
          }
          const ok = allowed.some((d) => host === d || host.endsWith(`.${d}`));
          if (!ok) {
            return c.json(
              { success: false, error: { code: 'FORBIDDEN', message: 'Origin not allowed' } },
              403,
            );
          }
        }

        c.set('widgetId', widgetId);
        c.set('workspaceId', clerkOrgId);
        c.set('internalWorkspaceId', internalWorkspaceId);
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
