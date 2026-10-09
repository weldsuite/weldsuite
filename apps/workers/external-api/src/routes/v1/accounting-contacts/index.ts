import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, getTableColumns, isNull, like, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { omitSensitive, sensitiveColumnsOf } from '@weldsuite/db/lib/sensitive-columns';
import {
  createAccountingContactSchema,
  updateAccountingContactSchema,
} from '@weldsuite/core-api-client/schemas/accounting-contacts';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';

const table = schema.parties;
const app = new Hono<HonoEnv>();

// `parties` holds the vendor's TIN and ACH account number as ciphertext
// (`sensitiveEncrypted`). It is never selected, so it never leaves the worker,
// is never echoed and never rides along in an entity event.
const columns = omitSensitive('parties', getTableColumns(table));

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  role: z.string().optional(),
});

/**
 * The request schema passes unknown keys through, and `parties` also holds
 * columns that feed the ledger (default revenue and expense accounts, tax
 * exemption, the outstanding balance) or point at the CRM identity rows. The
 * public API writes the two fields it documents, a name and a role, and
 * nothing else; the rest is set in WeldBooks.
 */
function toPartyColumns(body: Record<string, unknown>): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (body.name !== undefined) columns.displayName = body.name;
  if (body.type !== undefined) columns.role = body.type;
  return columns;
}

function toResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    name: row.displayName,
    type: row.role,
  };
}

app.get('/', requireScope('accounting_contacts:read'), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(or(like(table.displayName, term), like(table.partyCode, term)));
  }
  if (q.role) where.push(eq(table.role, q.role));
  const result = await listWithCursor({
    db,
    table,
    where,
    cursor: q.cursor,
    limit: q.limit,
    mapRow: (row) => toResponse(row as Record<string, unknown>),
    omit: sensitiveColumnsOf('parties'),
  });
  return list(
    c,
    result.data as Record<string, unknown>[],
    cursorPagination(result.totalCount, result.hasMore, result.cursor),
  );
});

app.get('/:id', requireScope('accounting_contacts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select(columns)
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Accounting contact', id);
  return success(c, toResponse(row as Record<string, unknown>));
});

app.post('/', requireScope('accounting_contacts:write'), zValidator('json', createAccountingContactSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const now = new Date();
  const id = generateId('acn');
  const insert = {
    id,
    ...toPartyColumns(body),
    role: (body.type as string | undefined) ?? 'customer',
    outstandingBalance: '0',
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(insert as typeof table.$inferInsert).returning(columns);
  if (!row) return error.internal(c, 'Failed to create accounting contact');
  const response = { ...body, ...toResponse(row as Record<string, unknown>) };
  publishEntityEvent({
    c,
    entityType: 'accounting_contact',
    entityId: id,
    action: 'created',
    data: response,
  });
  return success(c, response, 201);
});

app.patch('/:id', requireScope('accounting_contacts:write'), zValidator('json', updateAccountingContactSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json') as Record<string, unknown>;
  const [existing] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Accounting contact', id);
  const [row] = await db
    .update(table)
    .set({ ...toPartyColumns(body), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning(columns);
  if (!row) return error.internal(c, 'Failed to update accounting contact');
  const response = toResponse(row as Record<string, unknown>);
  publishEntityEvent({
    c,
    entityType: 'accounting_contact',
    entityId: id,
    action: 'updated',
    data: response,
  });
  return success(c, response);
});

app.delete('/:id', requireScope('accounting_contacts:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning({ id: table.id });
  if (!row) return error.notFound(c, 'Accounting contact', id);
  publishEntityEvent({
    c,
    entityType: 'accounting_contact',
    entityId: id,
    action: 'deleted',
    data: { id },
  });
  return noContent(c);
});

export default app;
