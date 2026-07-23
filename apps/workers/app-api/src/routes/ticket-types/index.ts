/**
 * Ticket type routes — flat /api/ticket-types/* surface backed by `helpdeskTicketTypes`.
 *
 * Permissions: tickets:read | tickets:create | tickets:update | tickets:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTicketTypeSchema, updateTicketTypeSchema } from '@weldsuite/core-api-client/schemas/ticket-types';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import type { Database } from '../../db';
import type { TicketTypeField } from '@weldsuite/db/schema';
import { syncTicketTypeDefinitions } from '@weldsuite/db/lib/custom-field-ticket-types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskTicketTypes;

/**
 * Best-effort mirror of a ticket type's fields into custom_field_definitions.
 * Never throws — a sync failure must not fail the ticket-type write (the row is
 * already persisted). Drift is self-healing: the next edit re-syncs, and the
 * Pile B backfill auto-creates any definition still missing.
 */
async function syncDefinitions(
  db: Database,
  ticketTypeId: string,
  fields: TicketTypeField[] | undefined,
): Promise<void> {
  try {
    await syncTicketTypeDefinitions(db, generateId, ticketTypeId, fields);
  } catch (err) {
    console.error('[app-api/ticket-types] definition sync failed:', err);
  }
}

app.get('/', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
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
    console.error('[app-api/ticket-types] list failed:', err);
    return error.internal(c, 'Failed to list ticket types');
  }
});

app.get('/:id', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Ticket type', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/ticket-types] get failed:', err);
    return error.internal(c, 'Failed to fetch ticket type');
  }
});

app.post('/', requirePermission('tickets:create'), zValidator('json', createTicketTypeSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('tty');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    // Pile B: mirror the ticket type's dynamic-form fields into scoped
    // custom_field_definitions so ticket field values can live in the typed
    // store. Best-effort (never fails the ticket-type write) — drift self-heals
    // on the next edit and the backfill reconciles it.
    await syncDefinitions(db, id, (data as Record<string, unknown>).fields as TicketTypeField[] | undefined);
    publishEntityEvent({ c, entityType: 'helpdesk_ticket_type', entityId: id, action: 'created', data: { id, name: (data as Record<string, unknown>).name } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/ticket-types] create failed:', err);
    return error.internal(c, 'Failed to create ticket type');
  }
});

app.patch('/:id', requirePermission('tickets:update'), zValidator('json', updateTicketTypeSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Ticket type', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    // Re-sync definitions only when the fields array was part of this patch.
    if (data.fields !== undefined) {
      await syncDefinitions(db, id, data.fields as TicketTypeField[] | undefined);
    }
    publishEntityEvent({ c, entityType: 'helpdesk_ticket_type', entityId: id, action: 'updated', data: { id, name: (update.name as string | undefined) ?? existing.name } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/ticket-types] update failed:', err);
    return error.internal(c, 'Failed to update ticket type');
  }
});

app.delete('/:id', requirePermission('tickets:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Ticket type', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'helpdesk_ticket_type', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/ticket-types] delete failed:', err);
    return error.internal(c, 'Failed to delete ticket type');
  }
});

export const ticketTypesRoutes = app;
