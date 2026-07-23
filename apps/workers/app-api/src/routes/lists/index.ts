/**
 * Lists routes — flat /api/lists/* surface backed by the new `lists` +
 * `list_members` tables. Replaces the legacy `customer_lists` +
 * `customer_list_members` + `contact_list_members` triple.
 *
 * Every list has a fixed `kind` ('company' | 'person') chosen at create time.
 * Members of a list are addressed by `entityId` against the matching identity
 * table.
 *
 * Permissions reuse the new `companies:*` / `people:*` keys.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  addListMembersSchemaV2,
  createListSchemaV2,
  updateListSchemaV2,
  listListsQueryV2,
} from '@weldsuite/core-api-client/schemas/lists';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.lists;
const lm = schema.listMembers;

app.get(
  '/',
  requirePermission('companies:read'),
  zValidator('query', listListsQueryV2),
  async (c) => {
    const db = c.get('tenantDb');
    const q = c.req.valid('query');

    const conditions: any[] = [isNull(t.deletedAt)];
    if (q.search) conditions.push(like(t.name, `%${q.search}%`));
    if (q.kind) conditions.push(eq(t.kind, q.kind));
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
    const where = and(...conditions);
    const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;

    try {
      const [rawRows, countRes] = await Promise.all([
        db
          .select({
            id: t.id,
            name: t.name,
            kind: t.kind,
            type: t.type,
            color: t.color,
            icon: t.icon,
            description: t.description,
            linkedListId: t.linkedListId,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            memberCount: sql<number>`(select count(*) from ${lm} where ${lm.listId} = ${t.id})::int`,
          })
          .from(t)
          .where(where)
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(q.limit + 1),
        db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
      ]);
      const hasMore = rawRows.length > q.limit;
      const sliced = hasMore ? rawRows.slice(0, q.limit) : rawRows;
      const data = sliced.map((r) => ({ ...r, memberCount: Number(r.memberCount ?? 0) }));
      const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
      const totalCount = Number(countRes[0]?.count ?? 0);
      return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
    } catch (err) {
      console.error('[app-api/lists] list failed:', err);
      return error.internal(c, 'Failed to list lists');
    }
  },
);

app.get('/:id', requirePermission('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'List', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/lists] get failed:', err);
    return error.internal(c, 'Failed to fetch list');
  }
});

app.post(
  '/',
  requirePermission('companies:create'),
  zValidator('json', createListSchemaV2),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const id = generateId('list');
    const now = new Date();
    try {
      await db.insert(t).values({
        id,
        name: data.name,
        kind: data.kind,
        type: data.type,
        color: data.color,
        icon: data.icon,
        description: data.description ?? null,
        filterRules: data.filterRules ?? null,
        createdAt: now,
        updatedAt: now,
      });
      const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'customer_list',
        entityId: id,
        action: 'created',
        data: { id, name: data.name, kind: data.kind },
      });
      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/lists] create failed:', err);
      return error.internal(c, 'Failed to create list');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('companies:update'),
  zValidator('json', updateListSchemaV2),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
      if (!existing) return error.notFound(c, 'List', id);
      const update: Record<string, unknown> = { updatedAt: new Date() };
      for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
      await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
      const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      publishEntityEvent({
        c,
        entityType: 'customer_list',
        entityId: id,
        action: 'updated',
        data: {
          id,
          name: (update.name as string | undefined) ?? existing.name,
          kind: existing.kind,
        },
      });
      return success(c, row);
    } catch (err) {
      console.error('[app-api/lists] update failed:', err);
      return error.internal(c, 'Failed to update list');
    }
  },
);

app.delete('/:id', requirePermission('companies:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'List', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'customer_list',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/lists] delete failed:', err);
    return error.internal(c, 'Failed to delete list');
  }
});

/**
 * GET /lists/:id/members — list membership for a single list. Returns the
 * entity rows joined from `companies` or `people` based on the list's `kind`.
 */
app.get('/:id/members', requirePermission('companies:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [parent] = await db
      .select({ id: t.id, kind: t.kind })
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);
    if (!parent) return error.notFound(c, 'List', id);

    if (parent.kind === 'company') {
      const rows = await db
        .select({
          memberId: lm.id,
          entityId: lm.entityId,
          addedAt: lm.addedAt,
          entity: schema.companies,
        })
        .from(lm)
        .innerJoin(schema.companies, eq(schema.companies.id, lm.entityId))
        .where(eq(lm.listId, id))
        .orderBy(desc(lm.addedAt));
      return success(c, rows);
    }

    const rows = await db
      .select({
        memberId: lm.id,
        entityId: lm.entityId,
        addedAt: lm.addedAt,
        entity: schema.people,
      })
      .from(lm)
      .innerJoin(schema.people, eq(schema.people.id, lm.entityId))
      .where(eq(lm.listId, id))
      .orderBy(desc(lm.addedAt));
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/lists] list members failed:', err);
    return error.internal(c, 'Failed to fetch list members');
  }
});

/**
 * POST /lists/:id/members — bulk-add entities to a list. Idempotent — members
 * already present are silently skipped. Entity ids must match the list's `kind`.
 */
app.post(
  '/:id/members',
  requirePermission('companies:update'),
  zValidator('json', addListMembersSchemaV2),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { entityIds } = c.req.valid('json');
    try {
      const [parent] = await db
        .select({ id: t.id, kind: t.kind })
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!parent) return error.notFound(c, 'List', id);

      // Defence in depth: only accept entityIds that resolve in the matching
      // identity table. Cross-kind ids are silently dropped, never inserted.
      const dedupedIds = Array.from(new Set(entityIds));
      const validRows =
        parent.kind === 'company'
          ? await db
              .select({ id: schema.companies.id })
              .from(schema.companies)
              .where(
                and(
                  inArray(schema.companies.id, dedupedIds),
                  isNull(schema.companies.deletedAt),
                ),
              )
          : await db
              .select({ id: schema.people.id })
              .from(schema.people)
              .where(
                and(
                  inArray(schema.people.id, dedupedIds),
                  isNull(schema.people.deletedAt),
                ),
              );
      const validIds = new Set(validRows.map((r) => r.id));

      const existing = await db
        .select({ entityId: lm.entityId })
        .from(lm)
        .where(and(eq(lm.listId, id), inArray(lm.entityId, dedupedIds)));
      const existingSet = new Set(existing.map((r) => r.entityId));
      const toAdd = dedupedIds.filter((eid) => validIds.has(eid) && !existingSet.has(eid));
      if (toAdd.length > 0) {
        await db.insert(lm).values(
          toAdd.map((entityId) => ({
            id: generateId('lm'),
            listId: id,
            entityId,
            addedAt: new Date(),
          })),
        );
      }
      return success(c, { id, added: toAdd.length });
    } catch (err) {
      console.error('[app-api/lists] add members failed:', err);
      return error.internal(c, 'Failed to add list members');
    }
  },
);

app.delete('/:id/members/:entityId', requirePermission('companies:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const entityId = c.req.param('entityId');
  try {
    await db.delete(lm).where(and(eq(lm.listId, id), eq(lm.entityId, entityId)));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/lists] remove member failed:', err);
    return error.internal(c, 'Failed to remove member from list');
  }
});

export const listsRoutes = app;
