/**
 * Team routes: /api/merge/teams/*.
 *
 *   GET    /      → teams, with their open issue counts   (merge_teams:read)
 *   GET    /:id   → one team                              (merge_teams:read)
 *   POST   /      → new team                              (merge_teams:manage)
 *   PATCH  /:id   → name, description, colour; the key only while the team has no issues (409)
 *   DELETE /:id   → refused (409) while the team has live issues
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { createMergeTeamSchema, updateMergeTeamSchema } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import type { Ctx } from '../shared';
import { publishEntityEvents } from '../../services/events';
import { teamDto } from '../../services/mappers';
import type { MergeTeamRow } from '../../services/db';
import { createTeam, deleteTeam, getTeam, listTeams, updateTeam, type TeamWriteResult } from '../../services/teams';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function publishTeamEvent(c: Ctx, team: MergeTeamRow, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvents(c, [
    { entityType: 'merge_team', action, entityId: team.id, data: { id: team.id, key: team.key, name: team.name } },
  ]);
}

function failure(c: Ctx, result: Extract<TeamWriteResult, { ok: false }>, id?: string) {
  switch (result.reason) {
    case 'not_found':
      return error.notFound(c, 'Team', id);
    case 'key_taken':
      return error.conflict(c, 'A team with this key already exists');
    case 'key_locked':
      return error.conflict(c, 'The key cannot change once the team has issues');
    case 'has_issues':
      return error.conflict(c, 'The team still has issues. Move or delete them first');
  }
}

app.get('/', requirePermission('merge_teams:read'), async (c) => {
  const teams = await listTeams(c.get('tenantDb'));
  return list(c, teams.map((t) => teamDto(t.row, t.openIssueCount)), cursorPagination(teams.length, false, null));
});

app.get('/:id', requirePermission('merge_teams:read'), async (c) => {
  const id = c.req.param('id');
  const team = await getTeam(c.get('tenantDb'), id);
  if (!team) return error.notFound(c, 'Team', id);
  return success(c, teamDto(team.row, team.openIssueCount));
});

app.post('/', requirePermission('merge_teams:manage'), zValidator('json', createMergeTeamSchema), async (c) => {
  const result = await createTeam(c.get('tenantDb'), c.req.valid('json'), c.get('userId'));
  if (!result.ok) return failure(c, result);
  publishTeamEvent(c, result.team, 'created');
  return success(c, teamDto(result.team, result.openIssueCount), 201);
});

app.patch('/:id', requirePermission('merge_teams:manage'), zValidator('json', updateMergeTeamSchema), async (c) => {
  const id = c.req.param('id');
  const result = await updateTeam(c.get('tenantDb'), id, c.req.valid('json'));
  if (!result.ok) return failure(c, result, id);
  publishTeamEvent(c, result.team, 'updated');
  return success(c, teamDto(result.team, result.openIssueCount));
});

app.delete('/:id', requirePermission('merge_teams:manage'), async (c) => {
  const id = c.req.param('id');
  const result = await deleteTeam(c.get('tenantDb'), id);
  if (!result.ok) return failure(c, result, id);
  publishTeamEvent(c, result.team, 'deleted');
  return noContent(c);
});

export default app;
