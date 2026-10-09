/**
 * Fiscal period routes — flat /api/fiscal-periods/* surface backed by `fiscalPeriods`.
 *
 * Lifecycle is guarded: `status` can only change through POST /:id/close and
 * POST /:id/reopen (which stamp closedAt/closedBy and hit the audit log) —
 * never through the generic PATCH. Closed periods block all bookings dated
 * inside them (see services/accounting-guards.ts) and cannot be deleted.
 *
 * GET /calendar and POST /generate build the periods of a fiscal year from the
 * entity's setup: calendar months, or 4-4-5 week periods for a 52-53-week year
 * (see calendar.ts).
 *
 * Permissions: reports:read | reports:create | reports:update | reports:delete.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, like, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createFiscalPeriodSchema, updateFiscalPeriodSchema } from '@weldsuite/core-api-client/schemas/fiscal-periods';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { resolveEntityId } from '../../lib/entity-context';
import { fiscalCalendarFor } from './calendar';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.fiscalPeriods;

/** Filters shared by the list query and its total count (everything but the cursor). */
function listFilterConditions(q: Record<string, string>): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt)];
  if (q.entityId) conditions.push(eq(t.entityId, q.entityId));
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.search) conditions.push(like(t.name, `%${q.search}%`));
  return conditions;
}

/** Keyset condition selecting periods older than the cursor row, if it exists. */
async function cursorCondition(db: Database, cursorId: string): Promise<SQL | undefined> {
  const [cur] = await db
    .select({ createdAt: t.createdAt, id: t.id })
    .from(t).where(eq(t.id, cursorId)).limit(1);
  if (!cur?.createdAt) return undefined;
  return sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`;
}

app.get('/', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const filterConditions = listFilterConditions(q);
  const cursorCond = q.cursor ? await cursorCondition(db, q.cursor) : undefined;
  const where = and(...filterConditions, cursorCond);
  const countWhere = and(...filterConditions);

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

// ---------------------------------------------------------------------------
// Period calendar of a fiscal year (month-based and 52-53-week entities).
// Registered before /:id so "calendar" is not read as an id.
// ---------------------------------------------------------------------------

const calendarQuerySchema = z.object({
  entityId: z.string().max(30).optional(),
  fiscalYear: z.coerce.number().int().min(1990).max(2200),
  includeQuarters: z.enum(['true', 'false']).optional(),
  includeYear: z.enum(['true', 'false']).optional(),
});

const generateSchema = z.object({
  entityId: z.string().max(30).optional(),
  fiscalYear: z.number().int().min(1990).max(2200),
  /** Also create the four quarters (they close and lock like months do). */
  includeQuarters: z.boolean().optional(),
  /** Also create one period for the whole fiscal year. */
  includeYear: z.boolean().optional(),
});

async function calendarContext(c: Context<{ Bindings: Env; Variables: Variables }>, db: Database, requestedEntityId: string | undefined) {
  const entityId = requestedEntityId ?? (await resolveEntityId(c, db));
  if (!entityId) return { error: error.badRequest(c, 'No accounting entity resolved') } as const;
  const [entity] = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  if (!entity) return { error: error.notFound(c, 'Accounting entity', entityId) } as const;
  return { entity } as const;
}

/** The existing, undeleted period rows of an entity that cover the same dates and type. */
async function existingPeriods(db: Database, entityId: string, from: string, to: string) {
  return db
    .select()
    .from(t)
    .where(and(eq(t.entityId, entityId), isNull(t.deletedAt), gte(t.startDate, from), lte(t.endDate, to)));
}

// GET /calendar?fiscalYear=2026[&entityId=][&includeQuarters=true][&includeYear=true]
// The periods of a fiscal year as the entity's setup defines them, and which of them exist already.
app.get('/calendar', requirePermission('reports:read'), zValidator('query', calendarQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  try {
    const ctx = await calendarContext(c, db, q.entityId);
    if ('error' in ctx) return ctx.error;
    const calendar = fiscalCalendarFor(ctx.entity, q.fiscalYear, {
      includeQuarters: q.includeQuarters === 'true',
      includeYear: q.includeYear === 'true',
    });
    const existing = await existingPeriods(db, ctx.entity.id, calendar.startDate, calendar.endDate);
    return success(c, {
      ...calendar,
      entityId: ctx.entity.id,
      periods: calendar.periods.map((period) => ({
        ...period,
        existingId:
          existing.find((row) => row.startDate === period.startDate && row.endDate === period.endDate && row.type === period.type)?.id ?? null,
      })),
    });
  } catch (err) {
    console.error('[app-api/fiscal-periods] calendar failed:', err);
    return error.internal(c, 'Failed to build the fiscal calendar');
  }
});

// POST /generate { fiscalYear, entityId?, includeQuarters?, includeYear? }
// Creates the (open) periods of a fiscal year that do not exist yet: calendar months for a
// month-based entity, 4-4-5 periods for a 52-53-week one (the 53rd week in period 12).
app.post('/generate', requirePermission('reports:create'), zValidator('json', generateSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const ctx = await calendarContext(c, db, data.entityId);
    if ('error' in ctx) return ctx.error;
    const calendar = fiscalCalendarFor(ctx.entity, data.fiscalYear, {
      includeQuarters: data.includeQuarters,
      includeYear: data.includeYear,
    });
    const existing = await existingPeriods(db, ctx.entity.id, calendar.startDate, calendar.endDate);
    const exists = (period: { startDate: string; endDate: string; type: string }) =>
      existing.some((row) => row.startDate === period.startDate && row.endDate === period.endDate && row.type === period.type);

    const now = new Date();
    const created = calendar.periods
      .filter((period) => !exists(period))
      .map((period) => ({
        id: generateId('fp'),
        entityId: ctx.entity.id,
        name: period.name,
        type: period.type,
        startDate: period.startDate,
        endDate: period.endDate,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      }));
    if (created.length > 0) await db.insert(t).values(created);
    for (const row of created) {
      publishEntityEvent({ c, entityType: 'fiscal_period', entityId: row.id, action: 'created', data: { id: row.id, name: row.name, status: 'open', entityId: row.entityId } });
    }
    return success(
      c,
      {
        entityId: ctx.entity.id,
        fiscalYear: calendar.fiscalYear,
        startDate: calendar.startDate,
        endDate: calendar.endDate,
        kind: calendar.kind,
        weeks: calendar.weeks,
        created,
        skipped: calendar.periods.filter(exists).map((period) => ({ name: period.name, startDate: period.startDate, endDate: period.endDate })),
      },
      201,
    );
  } catch (err) {
    console.error('[app-api/fiscal-periods] generate failed:', err);
    return error.internal(c, 'Failed to generate fiscal periods');
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
