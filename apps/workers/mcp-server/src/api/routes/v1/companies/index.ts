import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, isNull, like, or, type SQL } from 'drizzle-orm';
import { computeChanges, publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createCompanySchema,
  updateCompanySchema,
  listCompaniesQuery,
} from '@weldsuite/app-api-client/schemas/companies';

const table = schema.companies;
const app = new Hono<HonoEnv>();

/** Mirrors app-api's deriveDisplayName: tradingName wins, else name, else fallback. */
function deriveDisplayName(input: { name?: string | null; tradingName?: string | null }): string {
  return input.tradingName?.trim() || input.name?.trim() || 'Unnamed Company';
}

app.get('/', requireScope('companies:read'), zValidator('query', listCompaniesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(
      or(
        like(table.displayName, term),
        like(table.name, term),
        like(table.tradingName, term),
        like(table.email, term),
        like(table.vatNumber, term),
      ),
    );
  }
  if (q.status) where.push(eq(table.status, q.status));
  if (q.ownerId) where.push(eq(table.ownerId, q.ownerId));
  if (q.industry) where.push(eq(table.industry, q.industry));
  if (q.isSupplier !== undefined) where.push(eq(table.isSupplier, q.isSupplier));
  if (q.isLead !== undefined) where.push(eq(table.isLead, q.isLead));

  // List-membership filter — only kind='company' lists target companies.
  if (q.listId) {
    const [listRow] = await db
      .select({ kind: schema.lists.kind })
      .from(schema.lists)
      .where(and(eq(schema.lists.id, q.listId), isNull(schema.lists.deletedAt)))
      .limit(1);
    const memberRows = listRow?.kind === 'company'
      ? await db
          .select({ entityId: schema.listMembers.entityId })
          .from(schema.listMembers)
          .where(eq(schema.listMembers.listId, q.listId))
      : [];
    if (memberRows.length === 0) {
      return list(c, [], cursorPagination(0, false, null));
    }
    where.push(inArray(table.id, memberRows.map((m) => m.entityId)));
  }

  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Company', id);
  return success(c, row);
});

app.post('/', requireScope('companies:write'), zValidator('json', createCompanySchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const now = new Date();
  const id = generateId('company');
  const displayName = deriveDisplayName(body);
  const [row] = await db
    .insert(table)
    .values({ id, createdAt: now, updatedAt: now, ...(body as Record<string, unknown>), displayName } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create company');
  publishEntityEvent({
    c,
    entityType: 'company',
    entityId: id,
    action: 'created',
    data: { id, name: row.name, website: row.website, industry: row.industry },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('companies:write'), zValidator('json', updateCompanySchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  // `ifVersion` is an optimistic-concurrency hint, not a column — strip it.
  const { ifVersion: _ifVersion, ...body } = c.req.valid('json');
  const [existing] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Company', id);
  const update: Record<string, unknown> = { ...(body as Record<string, unknown>), updatedAt: new Date() };
  if (body.name !== undefined || body.tradingName !== undefined) {
    update.displayName = deriveDisplayName({
      name: body.name ?? existing.name,
      tradingName: body.tradingName ?? existing.tradingName,
    });
  }
  const [row] = await db
    .update(table)
    .set(update)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.internal(c, 'Failed to update company');
  publishEntityEvent({
    c,
    entityType: 'company',
    entityId: id,
    action: 'updated',
    data: { id, name: row.name, website: row.website, industry: row.industry },
    changes: computeChanges(existing as Record<string, unknown>, update, ['updatedAt', 'version']),
  });
  return success(c, row);
});

app.delete('/:id', requireScope('companies:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Company', id);
  publishEntityEvent({ c, entityType: 'company', entityId: id, action: 'deleted', data: { id } });
  return noContent(c);
});

export default app;
