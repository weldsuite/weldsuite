/**
 * Widget Authentication Middleware
 *
 * Two-phase lookup:
 * 1. Look up widget in master database's widget_registry to find workspaceId
 * 2. Get tenant database for that workspace and fetch full widget config
 *
 * Sets widgetId, workspaceId, and widgetConfig in the Hono context.
 */

import { createMiddleware } from 'hono/factory';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { getMasterDb, getTenantDbForWorkspace, schema, masterSchema } from '../db';

/**
 * Widget authentication middleware factory
 *
 * Validates that:
 * 1. x-widget-id header is present
 * 2. Widget exists in master registry and is active
 * 3. Widget config exists in tenant database
 *
 * Sets context variables:
 * - widgetId: The widget ID from the header
 * - workspaceId: The workspace ID owning the widget
 * - widgetConfig: Full widget configuration from tenant DB
 */
export function widgetAuthMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(
    async (c, next) => {
      // Get widget ID from header
      const widgetId = c.req.header('x-widget-id');

      if (!widgetId) {
        return c.json(
          {
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Missing x-widget-id header',
            },
          },
          401
        );
      }

      try {
        // Phase 1: Look up widget in master registry
        const masterDb = getMasterDb(c.env);
        const { widgetRegistry } = masterSchema;

        const registryResults = await masterDb
          .select({
            workspaceId: widgetRegistry.workspaceId,
            widgetName: widgetRegistry.widgetName,
            isActive: widgetRegistry.isActive,
          })
          .from(widgetRegistry)
          .where(eq(widgetRegistry.widgetId, widgetId))
          .limit(1);

        if (registryResults.length === 0) {
          console.log(`[Widget Auth] Widget not found in registry: ${widgetId}`);
          return c.json(
            {
              success: false,
              error: {
                code: 'UNAUTHORIZED',
                message: 'Invalid widget ID',
              },
            },
            401
          );
        }

        const registryEntry = registryResults[0];

        // Check if widget is active
        if (!registryEntry.isActive) {
          console.log(`[Widget Auth] Widget is inactive: ${widgetId}`);
          return c.json(
            {
              success: false,
              error: {
                code: 'UNAUTHORIZED',
                message: 'Widget is inactive',
              },
            },
            401
          );
        }

        const internalWorkspaceId = registryEntry.workspaceId;

        // Look up the Clerk org ID and plan from the workspaces table
        const { workspaces, plans } = masterSchema;
        const workspaceResults = await masterDb
          .select({
            clerkOrgId: workspaces.clerkOrgId,
            planId: workspaces.planId,
          })
          .from(workspaces)
          .where(eq(workspaces.id, internalWorkspaceId))
          .limit(1);

        if (workspaceResults.length === 0 || !workspaceResults[0].clerkOrgId) {
          console.log(`[Widget Auth] Workspace not found or missing clerkOrgId: ${internalWorkspaceId}`);
          return c.json(
            {
              success: false,
              error: {
                code: 'UNAUTHORIZED',
                message: 'Workspace configuration not found',
              },
            },
            401
          );
        }

        const clerkOrgId = workspaceResults[0].clerkOrgId;

        // Look up plan to determine branding
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
        console.log(`[Widget Auth] Resolved workspace ${internalWorkspaceId} to Clerk org ${clerkOrgId}`);

        // Phase 2: Get tenant database for this workspace using Clerk org ID
        console.log(`[Widget Auth] Getting tenant DB for workspace...`);
        const tenantDb = await getTenantDbForWorkspace(c.env, clerkOrgId);
        console.log(`[Widget Auth] Got tenant DB, querying widget config...`);
        const { helpdeskWidgetSettings } = schema;

        // Query tenant DB for widget config
        // Note: workspaceId filter removed since:
        // 1. Widget was already verified via master registry
        // 2. Tenant DB is workspace-scoped anyway
        const configResults = await tenantDb
          .select()
          .from(helpdeskWidgetSettings)
          .where(
            and(
              eq(helpdeskWidgetSettings.widgetId, widgetId),
              isNull(helpdeskWidgetSettings.deletedAt)
            )
          )
          .limit(1);

        if (configResults.length === 0) {
          console.log(`[Widget Auth] Widget config not found in tenant DB: ${widgetId} (clerkOrgId: ${clerkOrgId})`);
          return c.json(
            {
              success: false,
              error: {
                code: 'UNAUTHORIZED',
                message: 'Widget configuration not found',
              },
            },
            401
          );
        }

        const widgetConfig = configResults[0];

        // Set context variables
        // Use Clerk org ID as workspaceId since that's what the tenant DB uses
        c.set('widgetId', widgetId);
        c.set('workspaceId', clerkOrgId);
        c.set('internalWorkspaceId', internalWorkspaceId);
        c.set('widgetConfig', widgetConfig);
        c.set('tenantDb', tenantDb);
        c.set('removeBranding', removeBranding);

        console.log(`[Widget Auth] Authenticated widget ${widgetId} for workspace ${clerkOrgId} (internal: ${internalWorkspaceId})`);

        await next();
      } catch (err) {
        console.error('[Widget Auth] Database error:', err);
        return c.json(
          {
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Failed to authenticate widget',
            },
          },
          500
        );
      }
    }
  );
}
