/**
 * Fiscal period routes — flat /api/fiscal-periods/* surface backed by `fiscalPeriods`.
 *
 * Lifecycle is guarded: `status` can only change through POST /:id/close and
 * POST /:id/reopen (which stamp closedAt/closedBy and hit the audit log) —
 * never through the generic PATCH. Closed periods block all bookings dated
 * inside them (see services/accounting-guards.ts) and cannot be deleted.
 *
 * Permissions: reports:read | reports:create | reports:update | reports:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createFiscalPeriodSchema, updateFiscalPeriodSchema } from '@weldsuite/core-api-client/schemas/fiscal-periods';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { writeAccountingAudit } from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.fiscalPeriods;

app.get('/', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.entityId !== undefined && q.entityId !== '') conditions.push(eq(t.entityId, q.entityId));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.search) {
    conditions.push(like(t.name, `%${q.search}%`));
  }
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/fiscal-periods] list failed:', err);
    return error.internal(c, 'Failed to list fiscal periods');
  }
});

app.get('/:id', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Fiscal period', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/fiscal-periods] get failed:', err);
    return error.internal(c, 'Failed to fetch fiscal period');
  }
});

app.post('/', requirePermission('reports:create'), zValidator('json', createFiscalPeriodSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('fp');
  const now = new Date();
  try {
    // Periods are born open; closing is a separate, audited action.
    const { status: _ignoredStatus, closedAt: _c1, closedBy: _c2, ...rest } = data;
    await db.insert(t).values({ id, ...rest, status: 'open', createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({ c, entityType: 'fiscal_period', entityId: id, action: 'created', data: { id, name: data.name, status: 'open', entityId: data.entityId } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/fiscal-periods] create failed:', err);
    return error.internal(c, 'Failed to create fiscal period');
  }
});

app.patch('/:id', requirePermission('reports:update'), zValidator('json', updateFiscalPeriodSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Fiscal period', id);
    if (existing.status === 'closed') {
      return error.badRequest(c, 'Closed fiscal periods cannot be edited — reopen the period first');
    }

    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      // Status transitions only via /close and /reopen — silently editable
      // period status would defeat the closed-period booking guard.
      if (k === 'status' || k === 'closedAt' || k === 'closedBy') continue;
      if (v !== undefined) update[k] = v;
    }
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({ c, entityType: 'fiscal_period', entityId: id, action: 'updated', data: { id, name: (update.name as string | undefined) ?? existing.name, status: existing.status, entityId: (update.entityId as string | undefined) ?? existing.entityId } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/fiscal-periods] update failed:', err);
    return error.internal(c, 'Failed to update fiscal period');
  }
});

// POST /:id/close — open → closed
app.post('/:id/close', requirePermission('reports:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Fiscal period', id);
    if (existing.status === 'closed') return error.badRequest(c, 'Fiscal period is already closed');

    const now = new Date();
    await db.update(t)
      .set({ status: 'closed', closedAt: now, closedBy: userId, updatedAt: now })
      .where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'fiscal_period',
      entityId: id,
      action: 'closed',
      changes: { status: { old: existing.status, new: 'closed' } },
    });
    publishEntityEvent({ c, entityType: 'fiscal_period', entityId: id, action: 'updated', data: { id, name: existing.name, status: 'closed', entityId: existing.entityId } });
    return success(c, { id, status: 'closed' });
  } catch (err) {
    console.error('[app-api/fiscal-periods] close failed:', err);
    return error.internal(c, 'Failed to close fiscal period');
  }
});

// POST /:id/reopen — closed → open
app.post('/:id/reopen', requirePermission('reports:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Fiscal period', id);
    if (existing.status !== 'closed') return error.badRequest(c, 'Fiscal period is not closed');

    await db.update(t)
      .set({ status: 'open', closedAt: null, closedBy: null, updatedAt: new Date() })
      .where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'fiscal_period',
      entityId: id,
      action: 'reopened',
      changes: { status: { old: 'closed', new: 'open' } },
    });
    publishEntityEvent({ c, entityType: 'fiscal_period', entityId: id, action: 'updated', data: { id, name: existing.name, status: 'open', entityId: existing.entityId } });
    return success(c, { id, status: 'open' });
  } catch (err) {
    console.error('[app-api/fiscal-periods] reopen failed:', err);
    return error.internal(c, 'Failed to reopen fiscal period');
  }
});

app.delete('/:id', requirePermission('reports:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Fiscal period', id);
    if (existing.status === 'closed') {
      return error.badRequest(c, 'Closed fiscal periods cannot be deleted — reopen the period first');
    }
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'fiscal_period', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/fiscal-periods] delete failed:', err);
    return error.internal(c, 'Failed to delete fiscal period');
  }
});

export const fiscalPeriodsRoutes = app;
