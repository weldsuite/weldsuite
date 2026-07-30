import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like } from 'drizzle-orm';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';

const createQuoteSchema = z.object({
  name: z.string().min(1).max(255),
  quoteNumber: z.string().optional(),
  counterpartyId: z.string().optional(),
  personId: z.string().optional(),
  opportunityId: z.string().optional(),
  currency: z.string().max(10).optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  lineItems: z.array(z.record(z.unknown())).optional(),
  notes: z.string().optional(),
});

const updateQuoteSchema = createQuoteSchema.partial();

const listQuoteQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
});

const table = schema.crmQuotes;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('quotes:read'), zValidator('query', listQuoteQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (ReturnType<typeof like> | undefined)[] = [];
  if (q.search) where.push(like(table.name, `%${q.search}%`));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('quotes:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Quote', id);
  return success(c, row);
});

app.post('/', requireScope('quotes:write'), zValidator('json', createQuoteSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('quote');
  const values: Record<string, unknown> = { id, createdAt: now, updatedAt: now, ...body };
  if (body.validFrom) values.validFrom = new Date(body.validFrom);
  if (body.validUntil) values.validUntil = new Date(body.validUntil);
  const [row] = await db.insert(table).values(values as any).returning();
  return success(c, row, 201);
});

app.patch('/:id', requireScope('quotes:write'), zValidator('json', updateQuoteSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (body.validFrom) updates.validFrom = new Date(body.validFrom);
  if (body.validUntil) updates.validUntil = new Date(body.validUntil);
  const [row] = await db
    .update(table)
    .set(updates as any)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Quote', id);
  return success(c, row);
});

app.delete('/:id', requireScope('quotes:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Quote', id);
  return noContent(c);
});

export default app;
