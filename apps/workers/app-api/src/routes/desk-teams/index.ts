/**
 * WeldDesk v2 team-inbox routes — /api/desk/teams/* and /api/desk/teammates/me.
 *
 * This file exports two Hono routers: `deskTeamsRoutes` (mounted at
 * /api/desk/teams) and `deskTeammatesRoutes` (mounted separately at
 * /api/desk/teammates so GET/PUT land on exactly /api/desk/teammates/me —
 * see index.ts for both `app.route(...)` calls).
 *
 * Teams are small collections (a handful per workspace) — plain array
 * response, no cursor pagination (mirrors how other small-collection
 * app-api routes behave, e.g. departments/agents).
 *
 * Permissions: the dedicated `inboxes` object (read/create/update/delete)
 * introduced for the v2 schema (packages/core/permissions/src/catalog.ts).
 * Teammate "me" settings are self-service — gated on `inboxes:read` (any
 * teammate with inbox visibility can read/update their own status).
 *
 * Entity events: `desk_team` (created/updated/deleted) — deleted fires on
 * archive since teams are soft-deleted, never hard-deleted.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createDeskTeamSchema,
  updateDeskTeamSchema,
  listDeskTeamsQuerySchema,
  updateTeammateSettingsSchema,
} from '@weldsuite/core-api-client/schemas/desk-teams';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import {
  archiveDeskTeam,
  createDeskTeam,
  DeskTeamNotFoundError,
  getDeskTeam,
  getTeammateSettings,
  listDeskTeams,
  updateDeskTeam,
  upsertTeammateSettings,
} from '../../services/desk/teams';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
/** Mounted separately at /api/desk/teammates (see index.ts) so GET/PUT land on
 *  exactly /api/desk/teammates/me rather than nesting under /desk/teams. */
const teammatesApp = new Hono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Teams CRUD
// ---------------------------------------------------------------------------

app.get('/', requirePermission('inboxes:read'), zValidator('query', listDeskTeamsQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const { archived } = c.req.valid('query');
  try {
    const teams = await listDeskTeams(db, { archived });
    return success(c, teams);
  } catch (err) {
    console.error('[app-api/desk-teams] list failed:', err);
    return error.internal(c, 'Failed to list teams');
  }
});

app.post('/', requirePermission('inboxes:create'), zValidator('json', createDeskTeamSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const team = await createDeskTeam(db, data);
    publishEntityEvent({
      c,
      entityType: 'desk_team',
      action: 'created',
      entityId: team.id,
      data: team as unknown as Record<string, unknown>,
    });
    return success(c, team, 201);
  } catch (err) {
    console.error('[app-api/desk-teams] create failed:', err);
    return error.internal(c, 'Failed to create team');
  }
});

app.get('/:id', requirePermission('inboxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const team = await getDeskTeam(db, id);
    if (!team) return error.notFound(c, 'Team', id);
    return success(c, team);
  } catch (err) {
    console.error('[app-api/desk-teams] get failed:', err);
    return error.internal(c, 'Failed to fetch team');
  }
});

app.patch('/:id', requirePermission('inboxes:update'), zValidator('json', updateDeskTeamSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const team = await updateDeskTeam(db, id, data);
    publishEntityEvent({
      c,
      entityType: 'desk_team',
      action: 'updated',
      entityId: team.id,
      data: team as unknown as Record<string, unknown>,
    });
    return success(c, team);
  } catch (err) {
    if (err instanceof DeskTeamNotFoundError) return error.notFound(c, 'Team', id);
    console.error('[app-api/desk-teams] update failed:', err);
    return error.internal(c, 'Failed to update team');
  }
});

app.delete('/:id', requirePermission('inboxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const team = await archiveDeskTeam(db, id);
    publishEntityEvent({
      c,
      entityType: 'desk_team',
      action: 'deleted',
      entityId: team.id,
      data: team as unknown as Record<string, unknown>,
    });
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof DeskTeamNotFoundError) return error.notFound(c, 'Team', id);
    console.error('[app-api/desk-teams] archive failed:', err);
    return error.internal(c, 'Failed to archive team');
  }
});

// ---------------------------------------------------------------------------
// Teammate settings ("me")
// ---------------------------------------------------------------------------

teammatesApp.get('/me', requirePermission('inboxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const settings = await getTeammateSettings(db, userId);
    if (!settings) {
      // No row yet — return workspace defaults rather than 404 (self-service resource).
      return success(c, {
        userId,
        status: 'active' as const,
        assignmentLimit: null,
        lastAssignedAt: null,
        notificationPreferences: null,
      });
    }
    return success(c, settings);
  } catch (err) {
    console.error('[app-api/desk-teams] get teammate settings failed:', err);
    return error.internal(c, 'Failed to fetch teammate settings');
  }
});

teammatesApp.put(
  '/me',
  requirePermission('inboxes:read'),
  zValidator('json', updateTeammateSettingsSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const data = c.req.valid('json');
    try {
      const settings = await upsertTeammateSettings(db, userId, data);
      return success(c, settings);
    } catch (err) {
      console.error('[app-api/desk-teams] upsert teammate settings failed:', err);
      return error.internal(c, 'Failed to update teammate settings');
    }
  },
);

export const deskTeamsRoutes = app;
export const deskTeammatesRoutes = teammatesApp;
