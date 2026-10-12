/**
 * The suppression list: /api/reach/suppressions
 *
 * Permissions: reach_settings:read (list), reach_settings:update (add, delete).
 * Adding entries stops the matching prospects' queued and active enrollments;
 * removing one lets a prospect be enrolled again. No entity events: the list is
 * a compliance record, not a catalogued entity.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, ilike } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { addReachSuppressionsSchema } from '@weldsuite/app-api-client/schemas/reach';
import { reachSuppressions } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { cursorCondition, likePattern, pageOf, parseLimit } from '../../services/list-query';
import { completeAndPublish } from '../campaigns/events';
import {
  addSuppressions,
  applySuppressionsToProspects,
  releaseSuppressedProspects,
  toSuppressionDto,
} from '../../services/suppressions';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('reach_settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = parseLimit(q.limit);
  const search = q.search?.trim() ? ilike(reachSuppressions.value, likePattern(q.search)) : undefined;
  const after = await cursorCondition(db, reachSuppressions, q.cursor);
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(reachSuppressions)
      .where(and(search, after))
      .orderBy(desc(reachSuppressions.createdAt), desc(reachSuppressions.id))
      .limit(limit + 1),
    db.$count(reachSuppressions, search),
  ]);
  const page = pageOf(rows, limit);
  return list(c, page.data.map(toSuppressionDto), cursorPagination(Number(total), page.hasMore, page.nextCursor));
});

app.post('/', requirePermission('reach_settings:update'), zValidator('json', addReachSuppressionsSchema), async (c) => {
  const db = c.get('tenantDb');
  const result = await addSuppressions(db, c.req.valid('json').values, {
    reason: 'manual',
    source: 'manual',
    createdBy: c.get('userId'),
  });
  const { campaignIds } = await applySuppressionsToProspects(db, result.entries, 'manual');
  await completeAndPublish(c, db, campaignIds);
  return success(c, { added: result.added, skipped: result.skipped }, 201);
});

app.delete('/:id', requirePermission('reach_settings:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db.delete(reachSuppressions).where(eq(reachSuppressions.id, id)).returning();
  if (!row) return error.notFound(c, 'Suppression', id);
  await releaseSuppressedProspects(db, { value: row.value, type: row.type });
  return noContent(c);
});

export default app;
