/**
 * Appstore workspace surface — /api/appstore. The per-workspace /
 * per-user side of the app store that /api/app-catalog (catalog browse +
 * install/uninstall, ported separately) does NOT cover.
 *
 * Ported from apps/api-worker (W3 legacy-worker phase-out):
 *   - GET  /my-apps                      ← GET /settings/my-apps
 *   - GET  /installed-apps               ← GET /settings/installed-apps
 *   - GET  /can-manage-apps              ← GET /settings/can-manage-apps
 *   - POST /apps/:appCode/assign-all-members
 *       ← the `assignToAllMembers: true` branch of
 *         POST /settings/apps/:appCode/install. Install/uninstall themselves
 *         are NOT duplicated here — clients call
 *         POST/DELETE /api/app-catalog/:code/install and then this endpoint
 *         when "give access to all members" is ticked.
 *
 * Permissions: my-apps / can-manage-apps are self-scoped reads (baseline
 * general:read); installed-apps mirrors legacy general:read; assign-all
 * mirrors legacy install gating (general:update + tenant OWNER/ADMIN role
 * check — Clerk org:admin is broader than WeldSuite OWNER, so the canonical
 * role is read from the tenant DB, same stance as app-catalog).
 *
 * Entity events: none — `workspace_app` / app assignments are not in the
 * packages/core/entity-events catalog (same as app-catalog install).
 */

import { Hono } from 'hono';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { toDbCode } from '../../lib/legacy-app-codes';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { workspaceMembers, workspaceInstalledApps, userAppAssignments } = schema;

/**
 * GET /my-apps — app codes actively assigned to the caller.
 */
app.get('/my-apps', requirePermission('general:read'), async (c) => {
  const userId = c.get('userId');

  try {
    const db = c.get('tenantDb');

    const assignments = await db
      .select({ appCode: userAppAssignments.appCode })
      .from(userAppAssignments)
      .where(and(eq(userAppAssignments.userId, userId), eq(userAppAssignments.isActive, true)));

    return success(c, assignments.map((a) => a.appCode));
  } catch (err) {
    console.error('[app-api/appstore] Failed to fetch my apps:', err);
    return error.internal(c, 'Failed to fetch apps');
  }
});

/**
 * GET /installed-apps — full workspace_installed_apps rows (active only).
 * Role-filtered *codes* live at GET /api/dashboard/installed-apps; this is
 * the raw admin/settings view (legacy parity: full rows, any member with
 * general:read).
 */
app.get('/installed-apps', requirePermission('general:read'), async (c) => {
  try {
    const db = c.get('tenantDb');

    const apps = await db
      .select()
      .from(workspaceInstalledApps)
      .where(
        and(eq(workspaceInstalledApps.isActive, true), isNull(workspaceInstalledApps.deletedAt)),
      );

    return success(c, apps);
  } catch (err) {
    console.error('[app-api/appstore] Failed to fetch installed apps:', err);
    return error.internal(c, 'Failed to fetch installed apps');
  }
});

/**
 * GET /can-manage-apps — whether the caller may install/uninstall apps
 * (tenant OWNER/ADMIN). Errors degrade to { canManage: false } (legacy
 * behaviour — the app store must still render).
 */
app.get('/can-manage-apps', requirePermission('general:read'), async (c) => {
  const userId = c.get('userId');

  try {
    const db = c.get('tenantDb');

    const [member] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
      .limit(1);

    const canManage = member ? member.role === 'OWNER' || member.role === 'ADMIN' : false;

    return success(c, { canManage });
  } catch (err) {
    console.error('[app-api/appstore] Failed to check app management permission:', err);
    return success(c, { canManage: false });
  }
});

/**
 * POST /apps/:appCode/assign-all-members — grant an installed app to every
 * active MEMBER/VIEWER via user_app_assignments (OWNER and ADMIN bypass the
 * assignment table so they are skipped). Idempotent: conflicts are ignored.
 */
app.post(
  '/apps/:appCode/assign-all-members',
  requirePermission('general:update'),
  async (c) => {
    const userId = c.get('userId');
    // Normalise legacy codes (helpdesk → welddesk, mail → weldmail) exactly as
    // POST /api/app-catalog/:code/install does. Without this, the documented
    // install-then-assign flow 404s for mobile clients that still send the
    // legacy code: install writes `welddesk`, this lookup asks for `helpdesk`.
    const appCode = toDbCode(c.req.param('appCode'));

    try {
      const db = c.get('tenantDb');

      // Canonical role check on the tenant member row (legacy parity).
      const [member] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
        .limit(1);

      if (!member || (member.role !== 'OWNER' && member.role !== 'ADMIN')) {
        return error.forbidden(c, 'Only workspace admins can assign apps');
      }

      // The app must be actively installed in this workspace.
      const [installed] = await db
        .select({ id: workspaceInstalledApps.id })
        .from(workspaceInstalledApps)
        .where(
          and(
            eq(workspaceInstalledApps.appCode, appCode),
            eq(workspaceInstalledApps.isActive, true),
            isNull(workspaceInstalledApps.deletedAt),
          ),
        )
        .limit(1);

      if (!installed) return error.notFound(c, 'Installed app', appCode);

      const now = new Date();

      // All active members excluding OWNER and ADMIN (they bypass the table).
      const eligibleMembers = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.status, 'ACTIVE'),
            isNull(workspaceMembers.deletedAt),
            ne(workspaceMembers.role, 'OWNER'),
            ne(workspaceMembers.role, 'ADMIN'),
          ),
        );

      if (eligibleMembers.length > 0) {
        const assignmentRows = eligibleMembers.map((m) => ({
          id: generateId('uaa'),
          userId: m.userId,
          appCode,
          isActive: true,
          grantedAt: now,
          grantedBy: userId,
          createdAt: now,
          updatedAt: now,
        }));

        await db.insert(userAppAssignments).values(assignmentRows).onConflictDoNothing();
      }

      return success(c, { appCode, assignedCount: eligibleMembers.length });
    } catch (err) {
      console.error('[app-api/appstore] Failed to assign app to all members:', err);
      return error.internal(c, 'Failed to assign app');
    }
  },
);

export const appstoreRoutes = app;
