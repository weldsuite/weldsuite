/**
 * Federated Search Route
 *
 * POST /api/search
 *
 * Validates input, gates by permissions (the orchestrator silently drops
 * disallowed types), and fans out to per-entity search functions.
 *
 * Ported from apps/core-api/src/routes/search.ts during the core-api → app-api
 * migration. Read-only: no entity mutations, so no requirePermission() gate on
 * the collection — any authenticated user can call it and results are filtered
 * per-type via the permission registry in services/search.ts.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ensurePermissionsResolved } from '@weldsuite/permissions/server';
import { hasAnyPermission } from '@weldsuite/permissions';
import { searchInputSchema } from '@weldsuite/app-api-client/schemas/search';
import type { Env, Variables } from '../../types';
import { error } from '../../lib/response';
import { runSearch, type PermissionLike } from '../../services/search';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', zValidator('json', searchInputSchema), async (c) => {
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId') ?? '';

  // Resolve permissions inline — search has no requirePermission() gate (any
  // authenticated user can call it; results are filtered per-type below).
  let userPermissions: string[] = [];
  try {
    const resolved = await ensurePermissionsResolved(c);
    userPermissions = resolved?.permissions ?? [];
  } catch (err) {
    console.error('[app-api/search] Failed to resolve permissions:', err);
  }

  const perms: PermissionLike = {
    hasAny: (required) => hasAnyPermission(userPermissions, required),
  };

  const input = c.req.valid('json');

  try {
    const { groups, permittedTypes } = await runSearch(db, workspaceId, {
      q: input.q,
      types: input.types,
      limit: input.limit,
      perms,
    });

    return c.json({
      data: groups,
      query: input.q,
      permittedTypes,
    });
  } catch (err) {
    console.error('[app-api/search] Failed to run search:', err);
    return error.internal(c, 'Failed to run search');
  }
});

export const searchRoutes = app;
