import { Hono } from 'hono';
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
  createLeadSchema,
  updateLeadSchema,
  listLeadsQuery,
} from '@weldsuite/core-api-client/schemas/leads';

const table = schema.crmLeads;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('leads:read'), zValidator('query', listLeadsQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(
      or(
        like(table.email, term),
        like(table.fullName, term),
        like(table.companyName, term),
        like(table.firstName, term),
        like(table.lastName, term),
      ),
    );
  }
  if (q.status) where.push(eq(table.status, q.status));
  if (q.source) where.push(eq(table.source, q.source));
  if (q.rating) where.push(eq(table.rating, q.rating));
  if (q.ownerId) where.push(eq(table.ownerId, q.ownerId));
  if (q.isQualified !== undefined) where.push(eq(table.isQualified, q.isQualified));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('leads:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Lead', id);
  return success(c, row);
});

app.post('/', requireScope('leads:write'), zValidator('json', createLeadSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('lead');
  const fullName = [body.firstName, body.lastName].filter(Boolean).join(' ') || undefined;
  const values = {
    ...(body as Record<string, unknown>),
    id,
    ...(fullName ? { fullName } : {}),
    source: body.source ?? 'other',
    status: body.status ?? 'new',
    score: body.score ?? 0,
    ownerId: body.ownerId ?? c.get('apiSession').userId ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create lead');
  publishEntityEvent({
    c,
    entityType: 'lead',
    entityId: id,
    action: 'created',
    data: {
      id,
      email: row.email ?? '',
      firstName: row.firstName,
      lastName: row.lastName,
      title: row.title,
      status: row.status ?? 'new',
      source: row.source,
      ownerId: row.ownerId,
    },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('leads:write'), zValidator('json', updateLeadSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [existing] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Lead', id);
  const update: Record<string, unknown> = { ...(body as Record<string, unknown>), updatedAt: new Date() };
  // Recompute fullName when either name part is supplied.
  if (body.firstName !== undefined || body.lastName !== undefined) {
    const first = body.firstName ?? existing.firstName;
    const last = body.lastName ?? existing.lastName;
    const fullName = [first, last].filter(Boolean).join(' ');
    if (fullName) update.fullName = fullName;
  }
  const [row] = await db
    .update(table)
    .set(update)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.internal(c, 'Failed to update lead');
  publishEntityEvent({
    c,
    entityType: 'lead',
    entityId: id,
    action: 'updated',
    data: {
      id,
      email: row.email ?? '',
      firstName: row.firstName,
      lastName: row.lastName,
      title: row.title,
      status: row.status ?? 'new',
      source: row.source,
      ownerId: row.ownerId,
    },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('leads:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Lead', id);
  publishEntityEvent({
    c,
    entityType: 'lead',
    entityId: id,
    action: 'deleted',
    data: { id, email: row.email ?? '', status: row.status ?? 'new' },
  });
  return noContent(c);
});

export default app;
