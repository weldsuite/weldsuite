/**
 * Cohorts: /api/panel/cohorts/*. A cohort is a saved filter on tracked people,
 * evaluated at query time (`cohort` filters in a query spec, the recordings
 * list and the people list). Cohorts are shared by the whole workspace.
 *
 *   GET    /           → cohorts (?projectId)
 *   POST   /           → new cohort
 *   GET    /:id        → one cohort
 *   PATCH  /:id        → name, description, filter
 *   DELETE /:id        → soft delete
 *
 * Changing or deleting is for the owner, or for `panel_projects:manage`.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { createPanelCohortSchema, updatePanelCohortSchema } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelCohort } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import {
  cohortEventData,
  createCohort,
  deleteCohort,
  getCohort,
  listCohorts,
  projectExists,
  toCohortDto,
  updateCohort,
} from '../../services/saved-objects';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({ projectId: z.string().min(1).max(30).optional() });

function publish(c: Ctx, cohort: PanelCohort, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_cohort', entityId: cohort.id, action, data: cohortEventData(cohort) });
}

async function mayChange(c: Ctx, cohort: PanelCohort): Promise<boolean> {
  return cohort.ownerUserId === c.get('userId') || (await hasContextPermission(c, 'panel_projects:manage'));
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', listQuery), async (c) => {
  const cohorts = await listCohorts(c.get('tenantDb'), c.req.valid('query').projectId);
  return list(c, cohorts.map(toCohortDto), cursorPagination(cohorts.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelCohortSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  const cohort = await createCohort(db, input, userId);
  publish(c, cohort, 'created');
  return success(c, toCohortDto(cohort), 201);
});

app.get('/:id', requirePermission('panel_reports:read'), async (c) => {
  const id = c.req.param('id');
  const cohort = await getCohort(c.get('tenantDb'), id);
  if (!cohort) return error.notFound(c, 'Cohort', id);
  return success(c, toCohortDto(cohort));
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelCohortSchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getCohort(db, id);
  if (!existing) return error.notFound(c, 'Cohort', id);
  if (!(await mayChange(c, existing))) return error.forbidden(c, 'Only the owner can change this cohort');

  const cohort = await updateCohort(db, id, c.req.valid('json'));
  if (!cohort) return error.notFound(c, 'Cohort', id);
  publish(c, cohort, 'updated');
  return success(c, toCohortDto(cohort));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getCohort(db, id);
  if (!existing) return error.notFound(c, 'Cohort', id);
  if (!(await mayChange(c, existing))) return error.forbidden(c, 'Only the owner can delete this cohort');

  const cohort = await deleteCohort(db, id);
  if (!cohort) return error.notFound(c, 'Cohort', id);
  publish(c, cohort, 'deleted');
  return noContent(c);
});

export default app;
