import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, isNull, like, or, type SQL } from 'drizzle-orm';
import { computeChanges, publishEntityEvent } from '@weldsuite/entity-events';
import {
  getDefinitionsForEntityType,
  hydrateCustomFields,
  type CustomFieldDefinitionRow,
} from '@weldsuite/db/lib/custom-field-values';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  customFieldProblems,
  customFieldsRefused,
  listCustomFieldDefinitions,
  mergeCustomFields,
  writeCustomFields,
} from '../../../lib/custom-fields';
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

/** The companies a create links the person to: `companyIds`, plus `primaryCompanyId`. */
function employerIds(companyIds: string[] | undefined, primaryCompanyId: string | null | undefined): string[] {
  return [...new Set([...(companyIds ?? []), ...(primaryCompanyId ? [primaryCompanyId] : [])])];
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
  // Custom fields are read from the typed values table, as WeldCRM reads them.
  const rows = await hydrateCustomFields(db, 'person', result.data as (typeof table.$inferSelect)[]);
  return list(c, rows as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

/** The workspace's person custom fields: the slugs `customFields` takes. */
app.get('/custom-fields', requireScope('people:read'), async (c) => {
  const rows = await listCustomFieldDefinitions(c.get('tenantDb'), 'person');
  return list(c, rows, cursorPagination(rows.length, false, null));
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
  const [hydrated] = await hydrateCustomFields(db, 'person', [row]);
  return success(c, hydrated);
});

app.post('/', requireScope('people:write'), zValidator('json', createPersonSchema), async (c) => {
  const db = c.get('tenantDb');
  // companyIds/primaryCompanyId are not people columns: they become
  // person_companies rows. dateOfBirth must be coerced to a Date.
  const { companyIds, primaryCompanyId, dateOfBirth, ...body } = c.req.valid('json');

  // Everything the request names is checked before anything is written.
  const definitions = await getDefinitionsForEntityType(db, 'person');
  if (body.customFields) {
    const problems = customFieldProblems(definitions, body.customFields);
    if (Object.keys(problems).length > 0) return customFieldsRefused(c, problems);
  }
  const employers = employerIds(companyIds, primaryCompanyId);
  if (employers.length > 0) {
    const found = await db
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(and(inArray(schema.companies.id, employers), isNull(schema.companies.deletedAt)));
    const known = new Set(found.map((f) => f.id));
    const missing = employers.filter((companyId) => !known.has(companyId));
    if (missing.length > 0) {
      return error.badRequest(c, `Unknown company: ${missing.join(', ')}`, { field: 'companyIds', missing });
    }
  }

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
  await writeCustomFields(db, 'person', id, body.customFields, definitions);
  // One person's employments: independent rows, written together.
  await Promise.all(
    employers.map((companyId) =>
      db.insert(schema.personCompanies).values({
        id: generateId('pc'),
        createdAt: now,
        updatedAt: now,
        personId: id,
        companyId,
        isPrimary: companyId === primaryCompanyId,
      }),
    ),
  );
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
  const [hydrated] = await hydrateCustomFields(db, 'person', [row], definitions);
  return success(c, hydrated, 201);
});

app.patch('/:id', requireScope('people:write'), zValidator('json', updatePersonSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { dateOfBirth, customFields, ...body } = c.req.valid('json');
  // Employments are set on create; an update leaves them alone.
  delete body.companyIds;
  delete body.primaryCompanyId;
  const [existing] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Person', id);
  let definitions: CustomFieldDefinitionRow[] | undefined;
  if (customFields) {
    definitions = await getDefinitionsForEntityType(db, 'person');
    const problems = customFieldProblems(definitions, customFields);
    if (Object.keys(problems).length > 0) return customFieldsRefused(c, problems);
  }
  const update: Record<string, unknown> = { ...(body as Record<string, unknown>), updatedAt: new Date() };
  if (dateOfBirth) update.dateOfBirth = new Date(dateOfBirth);
  // Custom fields merge: the keys sent change, the others stay.
  if (customFields) update.customFields = mergeCustomFields(existing.customFields, customFields);
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
  if (definitions) await writeCustomFields(db, 'person', id, customFields, definitions);
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
  const [hydrated] = await hydrateCustomFields(db, 'person', [row], definitions);
  return success(c, hydrated);
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
