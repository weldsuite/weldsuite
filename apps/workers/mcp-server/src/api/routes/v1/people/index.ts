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
  createPersonSchema,
  updatePersonSchema,
  listPeopleQuery,
} from '@weldsuite/core-api-client/schemas/people';

const table = schema.people;
const app = new Hono<HonoEnv>();

/** Mirrors app-api's deriveDisplayName for people. */
function deriveDisplayName(input: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
}): string {
  const composed = [input.firstName, input.lastName].filter(Boolean).join(' ').trim();
  return composed || input.fullName?.trim() || input.email?.trim() || 'Unnamed';
}

app.get('/', requireScope('people:read'), zValidator('query', listPeopleQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) {
    const term = `%${q.search}%`;
    where.push(
      or(
        like(table.displayName, term),
        like(table.fullName, term),
        like(table.firstName, term),
        like(table.lastName, term),
        like(table.email, term),
      ),
    );
  }
  if (q.status) where.push(eq(table.status, q.status));
  if (q.ownerId) where.push(eq(table.ownerId, q.ownerId));
  if (q.isSupplier !== undefined) where.push(eq(table.isSupplier, q.isSupplier));
  if (q.isLead !== undefined) where.push(eq(table.isLead, q.isLead));

  // Company-membership filter — current employments only (endedAt IS NULL).
  if (q.companyId) {
    const memberRows = await db
      .select({ personId: schema.personCompanies.personId })
      .from(schema.personCompanies)
      .where(and(eq(schema.personCompanies.companyId, q.companyId), isNull(schema.personCompanies.endedAt)));
    if (memberRows.length === 0) return list(c, [], cursorPagination(0, false, null));
    where.push(inArray(table.id, memberRows.map((m) => m.personId)));
  }

  // List-membership filter — only kind='person' lists target people.
  if (q.listId) {
    const [listRow] = await db
      .select({ kind: schema.lists.kind })
      .from(schema.lists)
      .where(and(eq(schema.lists.id, q.listId), isNull(schema.lists.deletedAt)))
      .limit(1);
    const memberRows = listRow?.kind === 'person'
      ? await db
          .select({ entityId: schema.listMembers.entityId })
          .from(schema.listMembers)
          .where(eq(schema.listMembers.listId, q.listId))
      : [];
    if (memberRows.length === 0) return list(c, [], cursorPagination(0, false, null));
    where.push(inArray(table.id, memberRows.map((m) => m.entityId)));
  }

  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('people:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Person', id);
  return success(c, row);
});

app.post('/', requireScope('people:write'), zValidator('json', createPersonSchema), async (c) => {
  const db = c.get('tenantDb');
  // companyIds/primaryCompanyId are not people columns (employment linking is
  // deferred); dateOfBirth must be coerced to a Date.
  const { companyIds: _companyIds, primaryCompanyId: _primaryCompanyId, dateOfBirth, ...body } = c.req.valid('json');
  const now = new Date();
  const id = generateId('person');
  const fullName = body.fullName || [body.firstName, body.lastName].filter(Boolean).join(' ') || undefined;
  const displayName = deriveDisplayName({ ...body, fullName });
  const values: Record<string, unknown> = {
    ...(body as Record<string, unknown>),
    id,
    ...(fullName ? { fullName } : {}),
    displayName,
    ...(dateOfBirth ? { dateOfBirth: new Date(dateOfBirth) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create person');
  publishEntityEvent({
    c,
    entityType: 'person',
    entityId: id,
    action: 'created',
    data: {
      id,
      firstName: row.firstName,
      lastName: row.lastName,
      fullName: row.fullName,
      displayName: row.displayName,
      email: row.email,
      title: row.title,
    },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('people:write'), zValidator('json', updatePersonSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { companyIds: _companyIds, primaryCompanyId: _primaryCompanyId, dateOfBirth, ...body } = c.req.valid('json');
  const [existing] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Person', id);
  const update: Record<string, unknown> = { ...(body as Record<string, unknown>), updatedAt: new Date() };
  if (dateOfBirth) update.dateOfBirth = new Date(dateOfBirth);
  // Recompute fullName + displayName when any name part is supplied.
  if (body.firstName !== undefined || body.lastName !== undefined || body.fullName !== undefined) {
    const firstName = body.firstName ?? existing.firstName;
    const lastName = body.lastName ?? existing.lastName;
    const fullName = body.fullName || [firstName, lastName].filter(Boolean).join(' ') || existing.fullName || undefined;
    if (fullName) update.fullName = fullName;
    update.displayName = deriveDisplayName({
      firstName,
      lastName,
      fullName,
      email: (body.email as string | undefined) ?? existing.email,
    });
  }
  const [row] = await db
    .update(table)
    .set(update)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.internal(c, 'Failed to update person');
  publishEntityEvent({
    c,
    entityType: 'person',
    entityId: id,
    action: 'updated',
    data: {
      id,
      firstName: row.firstName,
      lastName: row.lastName,
      fullName: row.fullName,
      displayName: row.displayName,
      email: row.email,
      title: row.title,
    },
    changes: computeChanges(existing as Record<string, unknown>, update, ['updatedAt', 'version']),
  });
  return success(c, row);
});

app.delete('/:id', requireScope('people:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Person', id);
  publishEntityEvent({ c, entityType: 'person', entityId: id, action: 'deleted', data: { id } });
  return noContent(c);
});

export default app;
