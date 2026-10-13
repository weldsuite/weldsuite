/**
 * Prospect lists: /api/reach/lists
 *
 * Permissions: reach_prospects:read | create | update | delete.
 * Lists are organisation only (no entity-event type exists for them); the
 * prospects themselves publish `reach_prospect` events.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createReachListSchema,
  reachListMembersSchema,
  updateReachListSchema,
} from '@weldsuite/app-api-client/schemas/reach';
import { reachProspectLists } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { createList, deleteList, findList, toProspectList } from '../../services/lists';
import { addProspectsToList, removeProspectsFromList } from '../../services/prospects';
import { cursorCondition, pageOf, parseLimit } from '../../services/list-query';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('reach_prospects:read'), async (c) => {
  const db = c.get('tenantDb');
  const limit = parseLimit(c.req.query('limit'));
  const base = isNull(reachProspectLists.deletedAt);
  const after = await cursorCondition(db, reachProspectLists, c.req.query('cursor'));
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(reachProspectLists)
      .where(and(base, after))
      .orderBy(desc(reachProspectLists.createdAt), desc(reachProspectLists.id))
      .limit(limit + 1),
    db.$count(reachProspectLists, base),
  ]);
  const page = pageOf(rows, limit);
  return list(c, page.data.map(toProspectList), cursorPagination(Number(total), page.hasMore, page.nextCursor));
});

app.get('/:id', requirePermission('reach_prospects:read'), async (c) => {
  const row = await findList(c.get('tenantDb'), c.req.param('id'));
  if (!row) return error.notFound(c, 'List', c.req.param('id'));
  return success(c, toProspectList(row));
});

app.post('/', requirePermission('reach_prospects:create'), zValidator('json', createReachListSchema), async (c) => {
  const input = c.req.valid('json');
  const row = await createList(c.get('tenantDb'), { ...input, createdBy: c.get('userId') });
  return success(c, toProspectList(row), 201);
});

app.patch('/:id', requirePermission('reach_prospects:update'), zValidator('json', updateReachListSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const [row] = await db
    .update(reachProspectLists)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(reachProspectLists.id, id), isNull(reachProspectLists.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'List', id);
  return success(c, toProspectList(row));
});

app.delete('/:id', requirePermission('reach_prospects:delete'), async (c) => {
  const id = c.req.param('id');
  if (!(await deleteList(c.get('tenantDb'), id))) return error.notFound(c, 'List', id);
  return noContent(c);
});

app.post('/:id/members', requirePermission('reach_prospects:update'), zValidator('json', reachListMembersSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await findList(db, id))) return error.notFound(c, 'List', id);
  const added = await addProspectsToList(db, id, c.req.valid('json').prospectIds);
  return success(c, { added });
});

app.post('/:id/members/remove', requirePermission('reach_prospects:update'), zValidator('json', reachListMembersSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!(await findList(db, id))) return error.notFound(c, 'List', id);
  const removed = await removeProspectsFromList(db, id, c.req.valid('json').prospectIds);
  return success(c, { removed });
});

export default app;
