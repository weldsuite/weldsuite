import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  syncValuesForEntity,
  hydrateCustomFields,
  hydrateCustomFieldsOne,
  getDefinitionsForTicket,
} from '@weldsuite/db/lib/custom-field-values';
import {
  createTicketSchema,
  updateTicketSchema,
  listTicketsQuery,
} from '@weldsuite/app-api-client/schemas/tickets';
import { createTicketMessageSchema } from '@weldsuite/core-api-client/schemas/ticket-messages';

// Nested message create takes ticketId from the URL, not the body.
const createMessageBody = createTicketMessageSchema.omit({ ticketId: true });

const listMessagesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
});

const ticketTable = schema.helpdeskTickets;
const msgTable = schema.helpdeskTicketMessages;

const app = new Hono<HonoEnv>();

// ---- Tickets ----------------------------------------------------------------

app.get('/', requireScope('tickets:read'), zValidator('query', listTicketsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(
      or(
        like(ticketTable.subject, term),
        like(ticketTable.customerEmail, term),
        like(ticketTable.customerName, term),
        like(ticketTable.ticketNumber, term),
      ),
    );
  }
  if (q.status) where.push(eq(ticketTable.status, q.status));
  if (q.priority) where.push(eq(ticketTable.priority, q.priority));
  if (q.assigneeId) where.push(eq(ticketTable.assigneeId, q.assigneeId));
  if (q.departmentId) where.push(eq(ticketTable.departmentId, q.departmentId));
  if (q.channel) where.push(eq(ticketTable.channel, q.channel));
  if (q.category) where.push(eq(ticketTable.category, q.category));
  const result = await listWithCursor({ db, table: ticketTable, where, cursor: q.cursor, limit: q.limit });
  // Pile B: custom field values come from the typed table (blob fallback during
  // the migration window).
  const hydrated = await hydrateCustomFields(db, 'ticket', result.data as { id: string; customFields?: unknown }[]);
  return list(c, hydrated as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(ticketTable)
    .where(and(eq(ticketTable.id, id), isNull(ticketTable.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Ticket', id);
  return success(c, await hydrateCustomFieldsOne(db, 'ticket', row));
});

app.post('/', requireScope('tickets:write'), zValidator('json', createTicketSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('tkt');
  // ticketNumber is NOT NULL with no DB default — generate when absent.
  const ticketNumber =
    body.ticketNumber ?? `TKT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const [row] = await db
    .insert(ticketTable)
    .values({ id, createdAt: now, updatedAt: now, ...(body as Record<string, unknown>), ticketNumber } as typeof ticketTable.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create ticket');
  // Pile B dual-write, scoped to the ticket's type.
  const ticketDefs = await getDefinitionsForTicket(db, row.ticketTypeId);
  await syncValuesForEntity(db, 'ticket', id, body.customFields as Record<string, unknown> | null | undefined, generateId, ticketDefs);
  publishEntityEvent({
    c,
    entityType: 'ticket',
    entityId: id,
    action: 'created',
    data: {
      id,
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      channel: row.channel,
      assigneeId: row.assigneeId,
      contactId: row.contactId,
      departmentId: row.departmentId,
    },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('tickets:write'), zValidator('json', updateTicketSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(ticketTable)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(ticketTable.id, id), isNull(ticketTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Ticket', id);
  // Pile B dual-write, scoped to the (possibly updated) ticket type.
  const ticketDefs = await getDefinitionsForTicket(db, row.ticketTypeId);
  await syncValuesForEntity(db, 'ticket', id, body.customFields as Record<string, unknown> | null | undefined, generateId, ticketDefs);
  publishEntityEvent({
    c,
    entityType: 'ticket',
    entityId: id,
    action: 'updated',
    data: {
      id,
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      channel: row.channel,
      assigneeId: row.assigneeId,
      contactId: row.contactId,
      departmentId: row.departmentId,
    },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('tickets:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(ticketTable)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ticketTable.id, id), isNull(ticketTable.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Ticket', id);
  publishEntityEvent({
    c,
    entityType: 'ticket',
    entityId: id,
    action: 'deleted',
    data: { id, ticketNumber: row.ticketNumber, subject: row.subject, status: row.status },
  });
  return noContent(c);
});

// ---- Nested: /tickets/:ticketId/messages ------------------------------------

app.get('/:ticketId/messages', requireScope('tickets:read'), zValidator('query', listMessagesQuery), async (c) => {
  const db = c.get('tenantDb');
  const ticketId = c.req.param('ticketId') as string;
  const q = c.req.valid('query');
  const where = [eq(msgTable.ticketId, ticketId)];
  const result = await listWithCursor({ db, table: msgTable, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.post('/:ticketId/messages', requireScope('tickets:write'), zValidator('json', createMessageBody), async (c) => {
  const db = c.get('tenantDb');
  const ticketId = c.req.param('ticketId') as string;
  const body = c.req.valid('json');
  // body, authorName and authorEmail are NOT NULL with no DB default.
  if (!body.body) return error.badRequest(c, 'body is required');
  if (!body.authorName || !body.authorEmail) {
    return error.badRequest(c, 'authorName and authorEmail are required');
  }
  // Verify ticket exists
  const [ticket] = await db
    .select({ id: ticketTable.id })
    .from(ticketTable)
    .where(and(eq(ticketTable.id, ticketId), isNull(ticketTable.deletedAt)))
    .limit(1);
  if (!ticket) return error.notFound(c, 'Ticket', ticketId);
  const now = new Date();
  const id = generateId('tmsg');
  const [row] = await db
    .insert(msgTable)
    .values({ id, ticketId, createdAt: now, updatedAt: now, ...(body as Record<string, unknown>) } as typeof msgTable.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create ticket message');
  publishEntityEvent({
    c,
    entityType: 'helpdesk_message',
    entityId: id,
    action: 'created',
    data: { id, ticketId, authorId: body.authorId, subject: body.subject },
  });
  return success(c, row, 201);
});

export default app;
