/**
 * Label routes: /api/merge/labels/*. Reading needs `merge_teams:read`, changing
 * a label `merge_teams:manage`. A label with no team is available to every team.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { createMergeLabelSchema, updateMergeLabelSchema } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import type { Ctx } from '../shared';
import { publishEntityEvents } from '../../services/events';
import { labelDto } from '../../services/mappers';
import type { MergeLabelRow } from '../../services/db';
import { createLabel, deleteLabel, listLabels, updateLabel, type LabelWriteResult } from '../../services/labels';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function publishLabelEvent(c: Ctx, label: MergeLabelRow, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvents(c, [
    {
      entityType: 'merge_label',
      action,
      entityId: label.id,
      data: { id: label.id, teamId: label.teamId, name: label.name },
    },
  ]);
}

function failure(c: Ctx, result: Extract<LabelWriteResult, { ok: false }>, id?: string) {
  switch (result.reason) {
    case 'not_found':
      return error.notFound(c, 'Label', id);
    case 'team_not_found':
      return error.notFound(c, 'Team');
    case 'name_taken':
      return error.conflict(c, 'A label with this name already exists');
  }
}

app.get('/', requirePermission('merge_teams:read'), zValidator('query', z.object({ teamId: z.string().optional() })), async (c) => {
  const labels = await listLabels(c.get('tenantDb'), c.req.valid('query').teamId);
  return list(c, labels.map(labelDto), cursorPagination(labels.length, false, null));
});

app.post('/', requirePermission('merge_teams:manage'), zValidator('json', createMergeLabelSchema), async (c) => {
  const result = await createLabel(c.get('tenantDb'), c.req.valid('json'));
  if (!result.ok) return failure(c, result);
  publishLabelEvent(c, result.label, 'created');
  return success(c, labelDto(result.label), 201);
});

app.patch('/:id', requirePermission('merge_teams:manage'), zValidator('json', updateMergeLabelSchema), async (c) => {
  const id = c.req.param('id');
  const result = await updateLabel(c.get('tenantDb'), id, c.req.valid('json'));
  if (!result.ok) return failure(c, result, id);
  publishLabelEvent(c, result.label, 'updated');
  return success(c, labelDto(result.label));
});

app.delete('/:id', requirePermission('merge_teams:manage'), async (c) => {
  const id = c.req.param('id');
  const result = await deleteLabel(c.get('tenantDb'), id);
  if (!result.ok) return failure(c, result, id);
  publishLabelEvent(c, result.label, 'deleted');
  return noContent(c);
});

export default app;
