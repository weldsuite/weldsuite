/**
 * Cycle routes: /api/merge/cycles/*. Reading needs `merge_teams:read`, changing
 * a cycle `merge_teams:manage`. Numbers run per team; deleting a cycle leaves
 * its issues without one.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createMergeCycleSchema,
  listMergeCyclesQuerySchema,
  updateMergeCycleSchema,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import { unprocessable, type Ctx } from '../shared';
import { publishEntityEvents } from '../../services/events';
import { cycleDto } from '../../services/mappers';
import type { MergeCycleRow } from '../../services/db';
import { createCycle, deleteCycle, listCycles, updateCycle, type CycleWriteResult } from '../../services/cycles';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function publishCycleEvent(c: Ctx, cycle: MergeCycleRow, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvents(c, [
    {
      entityType: 'merge_cycle',
      action,
      entityId: cycle.id,
      data: { id: cycle.id, teamId: cycle.teamId, number: cycle.number, name: cycle.name },
    },
  ]);
}

function failure(c: Ctx, result: Extract<CycleWriteResult, { ok: false }>, id?: string) {
  switch (result.reason) {
    case 'not_found':
      return error.notFound(c, 'Cycle', id);
    case 'team_not_found':
      return error.notFound(c, 'Team');
    case 'invalid_range':
      return unprocessable(c, 'The cycle must end on or after its start');
  }
}

app.get('/', requirePermission('merge_teams:read'), zValidator('query', listMergeCyclesQuerySchema), async (c) => {
  const cycles = await listCycles(c.get('tenantDb'), c.req.valid('query').teamId);
  return list(
    c,
    cycles.map((x) => cycleDto(x.row, x.issueCount, x.completedIssueCount)),
    cursorPagination(cycles.length, false, null),
  );
});

app.post('/', requirePermission('merge_teams:manage'), zValidator('json', createMergeCycleSchema), async (c) => {
  const result = await createCycle(c.get('tenantDb'), c.req.valid('json'));
  if (!result.ok) return failure(c, result);
  publishCycleEvent(c, result.cycle.row, 'created');
  return success(c, cycleDto(result.cycle.row, result.cycle.issueCount, result.cycle.completedIssueCount), 201);
});

app.patch('/:id', requirePermission('merge_teams:manage'), zValidator('json', updateMergeCycleSchema), async (c) => {
  const id = c.req.param('id');
  const result = await updateCycle(c.get('tenantDb'), id, c.req.valid('json'));
  if (!result.ok) return failure(c, result, id);
  publishCycleEvent(c, result.cycle.row, 'updated');
  return success(c, cycleDto(result.cycle.row, result.cycle.issueCount, result.cycle.completedIssueCount));
});

app.delete('/:id', requirePermission('merge_teams:manage'), async (c) => {
  const id = c.req.param('id');
  const result = await deleteCycle(c.get('tenantDb'), id);
  if (!result.ok) return failure(c, result, id);
  publishCycleEvent(c, result.cycle.row, 'deleted');
  return noContent(c);
});

export default app;
