/**
 * Reporting dimensions (classes and locations): /api/accounting-dimensions.
 *
 * Invoice, bill and journal lines carry a `classId` / `locationId`; the
 * financial reports filter by them (`?classId=` / `?locationId=`). A value
 * belongs to one entity and one dimension, and may sit under a parent of the
 * same dimension. A value that is on any line can't be deleted, only
 * deactivated.
 *
 * GET / takes `dimension` (class | location), `isActive`, `parentId`, `search`,
 * `limit` (default 200, at most 500) and an opaque `cursor` (the pagination
 * block's `cursor`), ordered by name.
 *
 * Permissions: accounts:read | accounts:create | accounts:update | accounts:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { resolveEntityId } from '../../lib/entity-context';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.accountingDimensionValues;

const DIMENSIONS = ['class', 'location'] as const;

const createSchema = z.object({
  dimension: z.enum(DIMENSIONS),
  name: z.string().trim().min(1).max(255),
  code: z.string().trim().min(1).max(30).nullable().optional(),
  parentId: z.string().max(30).nullable().optional(),
  isActive: z.boolean().optional(),
});

/** The dimension of a value never changes. */
const updateSchema = createSchema.omit({ dimension: true }).partial();

type DimensionRow = typeof t.$inferSelect;

function eventData(row: DimensionRow) {
  return {
    id: row.id,
    dimension: row.dimension,
    name: row.name,
    code: row.code,
    parentId: row.parentId,
    isActive: row.isActive,
  };
}

function encodeCursor(row: Pick<DimensionRow, 'name' | 'id'>): string {
  return btoa(encodeURIComponent(JSON.stringify([row.name, row.id])));
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(cursor))) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') return [parsed[0], parsed[1]];
  } catch {
    // fall through
  }
  return null;
}

async function findValue(db: Database, id: string) {
  const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  return row ?? null;
}

/** Why `parentId` isn't acceptable as the parent of a value of this dimension, or null. */
async function parentError(
  db: Database,
  args: { entityId: string; dimension: string; parentId: string; selfId?: string },
): Promise<string | null> {
  if (args.parentId === args.selfId) return 'A value cannot be its own parent';
  let cursor: string | null = args.parentId;
  for (let depth = 0; cursor && depth < 25; depth++) {
    const parent: DimensionRow | null = await findValue(db, cursor);
    if (!parent || parent.entityId !== args.entityId || parent.dimension !== args.dimension) {
      return depth === 0 ? 'The parent must be an existing value of the same dimension' : null;
    }
    if (parent.parentId === args.selfId && args.selfId) return 'That parent would make the hierarchy circular';
    cursor = parent.parentId;
  }
  return null;
}

// GET /
app.get('/', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(Math.max(Number.parseInt(q.limit || '200', 10) || 200, 1), 500);

  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list — not an error.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));

    const conditions: SQL[] = [isNull(t.deletedAt), eq(t.entityId, entityId)];
    if (q.dimension) {
      if (!(DIMENSIONS as readonly string[]).includes(q.dimension)) return error.badRequest(c, "dimension must be 'class' or 'location'");
      conditions.push(eq(t.dimension, q.dimension));
    }
    if (q.isActive !== undefined) conditions.push(eq(t.isActive, q.isActive === 'true'));
    if (q.parentId) conditions.push(eq(t.parentId, q.parentId));
    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(or(like(t.name, term), like(t.code, term))!);
    }

    const total = await db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...conditions));

    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      if (!decoded) return error.badRequest(c, 'Invalid cursor');
      conditions.push(sql`(${t.name}, ${t.id}) > (${decoded[0]}, ${decoded[1]})`);
    }

    const rows = await db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(t.name, t.id)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return list(c, page, cursorPagination(Number(total[0]?.count ?? 0), hasMore, hasMore ? encodeCursor(page[page.length - 1]) : null));
  } catch (err) {
    console.error('[books-api/accounting-dimensions] list failed:', err);
    return error.internal(c, 'Failed to fetch dimension values');
  }
});

// GET /:id
app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await findValue(db, id);
    if (!row) return error.notFound(c, 'Dimension value', id);
    return success(c, row);
  } catch (err) {
    console.error('[books-api/accounting-dimensions] get failed:', err);
    return error.internal(c, 'Failed to fetch dimension value');
  }
});

// POST /
app.post('/', requirePermission('accounts:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    if (data.code) {
      const [duplicate] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.entityId, entityId), eq(t.dimension, data.dimension), eq(t.code, data.code), isNull(t.deletedAt)))
        .limit(1);
      if (duplicate) return error.conflict(c, `Code '${data.code}' is already used by another ${data.dimension}`);
    }
    if (data.parentId) {
      const problem = await parentError(db, { entityId, dimension: data.dimension, parentId: data.parentId });
      if (problem) return error.badRequest(c, problem);
    }

    const now = new Date();
    const row: DimensionRow = {
      id: generateId('dim'),
      entityId,
      dimension: data.dimension,
      name: data.name,
      code: data.code ?? null,
      parentId: data.parentId ?? null,
      isActive: data.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await db.insert(t).values(row);

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'accounting_dimension',
      entityId: row.id,
      action: 'created',
    });
    publishEntityEvent({ c, entityType: 'accounting_dimension', entityId: row.id, action: 'created', data: eventData(row) });

    return success(c, row, 201);
  } catch (err) {
    console.error('[books-api/accounting-dimensions] create failed:', err);
    return error.internal(c, 'Failed to create dimension value');
  }
});

// PATCH /:id
app.patch('/:id', requirePermission('accounts:update'), zValidator('json', updateSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const existing = await findValue(db, id);
    if (!existing) return error.notFound(c, 'Dimension value', id);

    if (data.code && data.code !== existing.code) {
      const [duplicate] = await db
        .select({ id: t.id })
        .from(t)
        .where(
          and(eq(t.entityId, existing.entityId), eq(t.dimension, existing.dimension), eq(t.code, data.code), isNull(t.deletedAt)),
        )
        .limit(1);
      if (duplicate && duplicate.id !== id) return error.conflict(c, `Code '${data.code}' is already used by another ${existing.dimension}`);
    }
    if (data.parentId) {
      const problem = await parentError(db, {
        entityId: existing.entityId,
        dimension: existing.dimension,
        parentId: data.parentId,
        selfId: id,
      });
      if (problem) return error.badRequest(c, problem);
    }

    const [updated] = await db
      .update(t)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .returning();
    if (!updated) return error.notFound(c, 'Dimension value', id);

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'accounting_dimension',
      entityId: id,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, { old: (existing as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({ c, entityType: 'accounting_dimension', entityId: id, action: 'updated', data: eventData(updated) });

    return success(c, updated);
  } catch (err) {
    console.error('[books-api/accounting-dimensions] update failed:', err);
    return error.internal(c, 'Failed to update dimension value');
  }
});

// DELETE /:id — soft delete; refused while the value has children or is on any line
app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const existing = await findValue(db, id);
    if (!existing) return error.notFound(c, 'Dimension value', id);

    const [child] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.parentId, id), isNull(t.deletedAt)))
      .limit(1);
    if (child) return error.conflict(c, 'This value has children — move or delete them first');

    const { journalLines, invoiceItems, billItems } = schema;
    const field = existing.dimension === 'class' ? 'classId' : 'locationId';
    const [onJournal, onInvoice, onBill] = await Promise.all([
      db.select({ id: journalLines.id }).from(journalLines).where(and(eq(journalLines[field], id), isNull(journalLines.deletedAt))).limit(1),
      db.select({ id: invoiceItems.id }).from(invoiceItems).where(and(eq(invoiceItems[field], id), isNull(invoiceItems.deletedAt))).limit(1),
      db.select({ id: billItems.id }).from(billItems).where(and(eq(billItems[field], id), isNull(billItems.deletedAt))).limit(1),
    ]);
    if (onJournal.length > 0 || onInvoice.length > 0 || onBill.length > 0) {
      return error.conflict(c, `This ${existing.dimension} is used on bookings — deactivate it instead`);
    }

    await db.update(t).set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() }).where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'accounting_dimension',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'accounting_dimension', entityId: id, action: 'deleted', data: { id } });

    return noContent(c);
  } catch (err) {
    console.error('[books-api/accounting-dimensions] delete failed:', err);
    return error.internal(c, 'Failed to delete dimension value');
  }
});

export const accountingDimensionsRoutes = app;
