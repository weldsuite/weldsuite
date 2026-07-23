/**
 * Current-user ("me") routes — self-scoped reads about the authenticated
 * caller that don't belong to any business object.
 *
 *   GET /permissions  — the caller's effective permissions for this workspace
 *
 * Mirrors the legacy api-worker `GET /settings/my-permissions` so first-party
 * clients that talk only to app-api (e.g. the WeldMail mobile app) can gate
 * their UI client-side. Intentionally ungated: every authenticated member may
 * read their own permissions (same precedent as the platform endpoint).
 */

import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import {
  createDrizzlePermissionQueries,
  resolveEffectivePermissions,
} from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /permissions — resolve the caller's effective permissions.
 *
 * Uses the shared @weldsuite/permissions resolver so behaviour stays in lock
 * step with the requirePermission() middleware that gates every mutation.
 */
app.get('/permissions', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');

  if (!orgId) {
    return error.orgRequired(c);
  }

  try {
    const db = c.get('tenantDb');
    const queries = createDrizzlePermissionQueries(db, schema, { eq, and, isNull });
    const resolved = await resolveEffectivePermissions(queries, userId);

    return success(c, {
      permissions: resolved.permissions,
      role: resolved.role,
      roleId: resolved.roleId,
      isOwner: resolved.isOwner,
    });
  } catch (err) {
    console.error('[me] Failed to resolve permissions:', err);
    return error.internal(c, 'Failed to fetch permissions');
  }
});

export { app as meRoutes };
