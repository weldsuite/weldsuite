/**
 * Roles routes — canonical custom-role CRUD for the platform settings UI.
 *
 *   GET    /api/roles                    — list roles (+ memberCount)   [roles:read]
 *   GET    /api/roles/permission-catalog — full permission catalog      [roles:read]
 *   GET    /api/roles/installable-apps   — workspace apps a role can grant [roles:read]
 *   GET    /api/roles/:roleId            — single role                  [roles:read]
 *   POST   /api/roles                    — create custom role           [roles:create]
 *   PUT    /api/roles/:roleId            — update name/perms/apps        [roles:update]
 *   DELETE /api/roles/:roleId            — soft-delete custom role       [roles:delete]
 *
 * A role carries both `permissions` and `apps`. App grants are live-derived
 * onto members at read time (see routes/dashboard installed-apps), so updating
 * a role's apps immediately changes what its members can open — no per-user
 * app writes here.
 *
 * Migrated from apps/api-worker/src/routes/settings (roles section), DELETE
 * included — it carries the WeldChat channel-link cleanup, whose dependencies
 * now live here (services/weldchat-role-links + services/realtime).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createRoleSchema, updateRoleSchema } from '@weldsuite/app-api-client/schemas/roles';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { schema } from '../../db';
import * as rolesService from '../../services/roles';
import { cleanupRoleLinksOnRoleDelete } from '../../services/weldchat-role-links';
import { publishChatMemberLeft } from '../../services/realtime/weldchat-publisher';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET / — list roles (seeds system roles on first call)
app.get('/', requirePermission('roles:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const result = await rolesService.listRoles(db);
    return success(c, result);
  } catch (err) {
    console.error('[app-api/roles] list failed:', err);
    return error.internal(c, 'Failed to fetch roles');
  }
});

// GET /permission-catalog — drives the role editor's permission checkbox grid.
// Must be defined before /:roleId so the literal segment wins.
app.get('/permission-catalog', requirePermission('roles:read'), async (c) => {
  const { PERMISSION_CATALOG_OBJECTS } = await import('@weldsuite/permissions/catalog');
  const objects = PERMISSION_CATALOG_OBJECTS.map((obj) => ({
    object: obj.key,
    objectName: obj.label,
    permissions: obj.permissions.map((p) => ({
      code: p.key,
      name: p.label,
      description: p.description,
      action: p.key.split(':').slice(1).join(':') || 'read',
      isGranted: false,
    })),
  }));
  return success(c, { objects });
});

// GET /installable-apps — workspace apps that a role can grant. Literal segment
// before /:roleId.
app.get('/installable-apps', requirePermission('roles:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const apps = await rolesService.listInstallableApps(db);
    return success(c, apps);
  } catch (err) {
    console.error('[app-api/roles] installable-apps failed:', err);
    return error.internal(c, 'Failed to fetch installable apps');
  }
});

// GET /:roleId — single role
app.get('/:roleId', requirePermission('roles:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const role = await rolesService.getRole(db, c.req.param('roleId'));
    if (!role) return error.notFound(c, 'Role', c.req.param('roleId'));
    return success(c, role);
  } catch (err) {
    console.error('[app-api/roles] get failed:', err);
    return error.internal(c, 'Failed to fetch role');
  }
});

// POST / — create custom role
app.post('/', requirePermission('roles:create'), zValidator('json', createRoleSchema), async (c) => {
  try {
    const db = c.get('tenantDb');
    const role = await rolesService.createRole(db, c.req.valid('json'));
    return success(c, role, 201);
  } catch (err) {
    console.error('[app-api/roles] create failed:', err);
    return error.internal(c, 'Failed to create role');
  }
});

// PUT /:roleId — update name / description / permissions / apps
app.put('/:roleId', requirePermission('roles:update'), zValidator('json', updateRoleSchema), async (c) => {
  try {
    const db = c.get('tenantDb');
    const result = await rolesService.updateRole(db, c.req.param('roleId'), c.req.valid('json'));
    if (!result.ok) {
      if (result.reason === 'not_found') return error.notFound(c, 'Role', c.req.param('roleId'));
      return error.forbidden(c, 'Cannot modify system roles');
    }
    return success(c, result.role);
  } catch (err) {
    console.error('[app-api/roles] update failed:', err);
    return error.internal(c, 'Failed to update role');
  }
});

// DELETE /:roleId — soft-delete a custom role.
//
// Tier note: `roles:delete` matches the legacy api-worker gate. This is a
// workspace-administration action, not a self-scoped one — SYSTEM_ROLES.MEMBER
// holds no `roles:*` permission at all and cannot reach the UI control, so the
// admin tier is correct here rather than a latent 403.
app.delete('/:roleId', requirePermission('roles:delete'), async (c) => {
  const roleId = c.req.param('roleId');
  try {
    const db = c.get('tenantDb');
    const { roles } = schema;

    const [existing] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
      .limit(1);

    if (!existing) return error.notFound(c, 'Role', roleId);
    if (existing.isSystem) return error.forbidden(c, 'Cannot delete system roles');

    const now = new Date();
    await db.update(roles).set({ deletedAt: now, updatedAt: now }).where(eq(roles.id, roleId));

    // Best-effort, exactly as in api-worker: drop every chat-channel link for
    // this role and clear the memberships it drove (keyed by
    // `addedByRoleId = roleId`, so manual joins stay sticky), then announce one
    // member-left per removed user. The role is already deleted by this point —
    // a cleanup or realtime failure is logged, never surfaced to the caller.
    try {
      const removed = await cleanupRoleLinksOnRoleDelete(db, roleId);
      for (const change of removed) {
        for (const userId of change.userIds) {
          try {
            await publishChatMemberLeft(c.env, change.channelId, {
              channelId: change.channelId,
              userId,
            });
          } catch (e) {
            console.error('[app-api/roles] realtime publish failed (role-delete remove):', e);
          }
        }
      }
    } catch (e) {
      console.error('[app-api/roles] failed to clean up chat role links on role delete:', e);
    }

    return noContent(c);
  } catch (err) {
    console.error('[app-api/roles] delete failed:', err);
    return error.internal(c, 'Failed to delete role');
  }
});

export const rolesRoutes = app;
