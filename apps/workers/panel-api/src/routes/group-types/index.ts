/**
 * Group types: /api/panel/group-types/*. The kinds of group a project's
 * events can belong to (`company`, `workspace`), with their display names and
 * the profile property matched against WeldCRM companies.
 *
 *   GET    /       → ?projectId: the configured types, then the types the project
 *                    collects without a row (`id: null`, `configured: false`)
 *   POST   /       → configure a type: takes one of the project's five slots
 *   PATCH  /:id    → names and the CRM match property (the type itself never changes)
 *   DELETE /:id    → removes the row and frees the slot (the profiles stay)
 *
 * A project collects at most `MAX_GROUP_TYPES` types; the PanelProject object
 * hands out the slots (ADR PANEL-004). A sixth row, or a type the object has no
 * slot for (data already named five others), is a 409 `GROUP_TYPE_LIMIT`.
 * Without the object binding the list still answers (nothing is collecting)
 * and creating answers 503. `panel_reports:*` like the other definitions.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createPanelGroupTypeSchema,
  panelGroupTypeListQuerySchema,
  updatePanelGroupTypeSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import type { PanelGroupType } from '@weldsuite/db/schema';
import { MAX_GROUP_TYPES } from '@weldsuite/panel-domain/wire';
import type { Env, Variables } from '../../types';
import { queryFailure } from '../../http';
import {
  collectedGroupTypes,
  createGroupType,
  deleteGroupType,
  getGroupTypeRow,
  groupTypeEventData,
  listGroupTypeRows,
  mergeGroupTypes,
  toGroupTypeDto,
  updateGroupType,
} from '../../services/groups';
import { getProject } from '../../services/projects';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function publish(c: Ctx, row: PanelGroupType, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_group_type', entityId: row.id, action, data: groupTypeEventData(row) });
}

function limitReached(c: Ctx, types: string[]): Response {
  return c.json(
    {
      error: {
        code: 'GROUP_TYPE_LIMIT',
        message: `A project collects at most ${MAX_GROUP_TYPES} group types. Delete one to make room.`,
        details: { max: MAX_GROUP_TYPES, types },
      },
    },
    409,
  );
}

/** Whether the object collects the type; false (with a warning) when it cannot be asked. */
async function isCollecting(c: Ctx, row: PanelGroupType): Promise<boolean> {
  try {
    return ((await collectedGroupTypes(c.env, row.projectId)) ?? []).includes(row.groupType);
  } catch (err) {
    console.warn(`[panel-api] could not read the collected group types (project ${row.projectId})`, err);
    return false;
  }
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', panelGroupTypeListQuerySchema), async (c) => {
  const { projectId } = c.req.valid('query');
  const db = c.get('tenantDb');
  if (!(await getProject(db, projectId))) return error.notFound(c, 'Project', projectId);

  const rows = await listGroupTypeRows(db, projectId);
  let collected: string[] | null;
  try {
    collected = await collectedGroupTypes(c.env, projectId);
  } catch (err) {
    return queryFailure(c, err);
  }
  const types = mergeGroupTypes(projectId, rows, collected);
  return list(c, types, cursorPagination(types.length, false, null));
});

app.post('/', requirePermission('panel_reports:create'), zValidator('json', createPanelGroupTypeSchema), async (c) => {
  const input = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await getProject(db, input.projectId))) return error.notFound(c, 'Project', input.projectId);

  let result: Awaited<ReturnType<typeof createGroupType>>;
  try {
    result = await createGroupType(c.env, db, input);
  } catch (err) {
    return queryFailure(c, err);
  }
  if (result.kind === 'duplicate') return error.conflict(c, `The group type '${input.groupType}' is already configured`);
  if (result.kind === 'limit') return limitReached(c, result.types);

  publish(c, result.row, 'created');
  return success(c, toGroupTypeDto(result.row, true), 201);
});

app.patch('/:id', requirePermission('panel_reports:update'), zValidator('json', updatePanelGroupTypeSchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getGroupTypeRow(db, id);
  if (!existing || !(await getProject(db, existing.projectId))) return error.notFound(c, 'Group type', id);

  const row = await updateGroupType(db, id, c.req.valid('json'));
  if (!row) return error.notFound(c, 'Group type', id);
  publish(c, row, 'updated');
  return success(c, toGroupTypeDto(row, await isCollecting(c, row)));
});

app.delete('/:id', requirePermission('panel_reports:delete'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await getGroupTypeRow(db, id);
  if (!existing || !(await getProject(db, existing.projectId))) return error.notFound(c, 'Group type', id);

  const row = await deleteGroupType(c.env, db, id);
  if (!row) return error.notFound(c, 'Group type', id);
  publish(c, row, 'deleted');
  return noContent(c);
});

export default app;
