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
  createConversationSchema,
  updateConversationSchema,
} from '@weldsuite/core-api-client/schemas/conversations';

const listConversationsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  assigneeId: z.string().optional(),
  departmentId: z.string().optional(),
});

const table = schema.helpdeskConversations;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('conversations:read'), zValidator('query', listConversationsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(like(table.subject, term), like(table.customerEmail, term), like(table.customerName, term)));
  }
  if (q.status) where.push(eq(table.status, q.status));
  if (q.assigneeId) where.push(eq(table.assigneeId, q.assigneeId));
  if (q.departmentId) where.push(eq(table.departmentId, q.departmentId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Conversation', id);
  return success(c, row);
});

app.post('/', requireScope('conversations:write'), zValidator('json', createConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  // customerName is NOT NULL in the DB but optional in the shared schema —
  // a conversation must identify a customer. Reject cleanly instead of 500ing.
  if (!body.customerName) {
    return error.badRequest(c, 'customerName is required to create a conversation');
  }
  const now = new Date();
  const id = generateId('conv');
  // conversationNumber is NOT NULL with no DB default — generate when absent
  // (mirrors the ticketNumber handling in the tickets route).
  const conversationNumber =
    ((body as Record<string, unknown>).conversationNumber as string | undefined) ??
    `CONV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const [row] = await db
    .insert(table)
    .values({ id, createdAt: now, updatedAt: now, ...(body as Record<string, unknown>), conversationNumber } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create conversation');
  publishEntityEvent({
    c,
    entityType: 'conversation',
    entityId: id,
    action: 'created',
    data: {
      id,
      conversationNumber: row.conversationNumber,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      assigneeId: row.assigneeId,
      contactId: row.contactId,
      departmentId: row.departmentId,
    },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('conversations:write'), zValidator('json', updateConversationSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Conversation', id);
  publishEntityEvent({
    c,
    entityType: 'conversation',
    entityId: id,
    action: 'updated',
    data: {
      id,
      conversationNumber: row.conversationNumber,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      assigneeId: row.assigneeId,
      contactId: row.contactId,
      departmentId: row.departmentId,
    },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('conversations:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Conversation', id);
  publishEntityEvent({
    c,
    entityType: 'conversation',
    entityId: id,
    action: 'deleted',
    data: { id, conversationNumber: row.conversationNumber, subject: row.subject, status: row.status },
  });
  return noContent(c);
});

export default app;
