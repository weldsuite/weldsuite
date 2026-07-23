/**
 * My role — /api/my-role. Self-scoped read of the caller's workspace role
 * plus derived management capabilities.
 *
 * Ported from apps/api-worker GET /settings/my-role (W3 legacy-worker
 * phase-out). Complements GET /api/me/permissions (which returns the raw
 * permission set); this endpoint keeps the legacy convenience shape
 * `{ role, canManageMembers, canManageRoles }` consumed by the platform's
 * resource-usage widget and settings shell.
 *
 * Intentionally ungated: every authenticated member may read their own role
 * (same precedent as /api/me/permissions).
 *
 * Entity events: none — read-only surface.
 */

import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import {
  createDrizzlePermissionQueries,
  resolveEffectivePermissions,
} from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / — the caller's workspace role and management capabilities.
 */
app.get('/', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');

  if (!orgId) {
    return error.orgRequired(c);
  }

  try {
    const db = c.get('tenantDb');
    const { workspaceMembers } = schema;

    const memberResult = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
      .limit(1);

    if (memberResult.length === 0) {
      return success(c, { role: null, canManageMembers: false, canManageRoles: false });
    }

    const member = memberResult[0];
    const role = member.role?.toUpperCase() || 'MEMBER';

    // Resolve actual permissions for accurate checks
    const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
    const resolved = await resolveEffectivePermissions(queries, userId);
    const perms = resolved.permissions;

    return success(c, {
      role,
      canManageMembers: hasPermission(perms, 'team:update'),
      canManageRoles: hasPermission(perms, 'roles:update'),
    });
  } catch (err) {
    console.error('[app-api/my-role] Failed to fetch my role:', err);
    return error.internal(c, 'Failed to fetch role');
  }
});

export const myRoleRoutes = app;
