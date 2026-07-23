/**
 * Canned response routes — flat /api/canned-responses/* surface backed by `helpdeskCannedResponses`.
 *
 * Permissions: tickets:read | tickets:create | tickets:update | tickets:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createCannedResponseSchema, updateCannedResponseSchema } from '@weldsuite/core-api-client/schemas/canned-responses';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskCannedResponses;

/** Picker search — ported from api-worker `GET /helpdesk/canned-responses/search`. */
const searchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().min(1).max(50).default(10),
});

/** Render payload — ported from api-worker `POST /helpdesk/canned-responses/:id/use`. */
const useCannedResponseSchema = z.object({
  variables: z.record(z.unknown()).optional(),
});

/**
 * Interpolate `{{variable}}` references using dot-notation paths.
 *
 * Byte-for-byte port of api-worker's helper: an unresolvable path is left as
 * the literal `{{path}}` rather than becoming "undefined".
 */
function interpolateVariables(text: string, context: Record<string, unknown>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const parts = path.trim().split('.');
    let value: unknown = context;
    for (const part of parts) {
      if (value && typeof value === 'object') {
        value = (value as Record<string, unknown>)[part];
      } else {
        return `{{${path}}}`;
      }
    }
    return value != null ? String(value) : `{{${path}}}`;
  });
}

app.get('/', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.departmentId !== undefined && q.departmentId !== '') conditions.push(eq(t.departmentId, q.departmentId));
  if (q.category !== undefined && q.category !== '') conditions.push(eq(t.category, q.category));
  if (q.search) {
    const term = `%${q.search}%`;
    conditions.push(or(like(t.name, term), like(t.subject, term))!);
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
    console.error('[app-api/canned-responses] list failed:', err);
    return error.internal(c, 'Failed to list canned responses');
  }
});

/**
 * GET /search — lightweight, scope-aware search for the reply picker.
 *
 * MUST stay declared above `GET /:id`, otherwise Hono resolves "search" as an
 * `:id` and this 404s.
 *
 * Distinct from `GET /` (which only matches name+subject): this ranks over
 * name/content/shortcut, returns active rows only, and hides other agents'
 * personal responses. Gated at `tickets:read` — the file's read tier, and the
 * tier a MEMBER composing a reply already holds (api-worker used
 * `settings:read`, also a MEMBER read tier, so this is not a tier change).
 */
app.get('/search', requirePermission('tickets:read'), zValidator('query', searchQuerySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { q, limit } = c.req.valid('query');
  const term = `%${q}%`;
  try {
    const rows = await db
      .select()
      .from(t)
      .where(
        and(
          isNull(t.deletedAt),
          eq(t.isActive, true),
          or(like(t.name, term), like(t.content, term), like(t.shortcut, term))!,
          // Personal responses are visible only to their author; team /
          // department / global are visible to everyone.
          or(and(eq(t.scope, 'personal'), eq(t.agentId, userId)), sql`${t.scope} != 'personal'`)!,
        ),
      )
      .orderBy(desc(t.usageCount), asc(t.name))
      .limit(limit);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/canned-responses] search failed:', err);
    return error.internal(c, 'Failed to search canned responses');
  }
});

/**
 * GET /categories — the distinct, non-null category names, sorted.
 *
 * Ported from api-worker `GET /helpdesk/canned-responses/categories`. Feeds the
 * category filter on the macro library; deriving it client-side would only ever
 * see the categories present on the current page.
 *
 * MUST stay declared above `GET /:id`, otherwise Hono resolves "categories" as
 * an `:id` and this 404s.
 *
 * Gated at `tickets:read` — this file's read tier, matching api-worker's
 * `settings:read`. Both are tiers a MEMBER holds, so this is not a tier change.
 */
app.get('/categories', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const rows = await db
      .selectDistinct({ category: t.category })
      .from(t)
      .where(and(isNull(t.deletedAt), sql`${t.category} IS NOT NULL`));

    const categories = rows
      .map((r) => r.category)
      .filter((cat): cat is string => cat !== null)
      .sort();

    return success(c, categories);
  } catch (err) {
    console.error('[app-api/canned-responses] categories failed:', err);
    return error.internal(c, 'Failed to fetch categories');
  }
});

app.get('/:id', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Canned response', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/canned-responses] get failed:', err);
    return error.internal(c, 'Failed to fetch canned response');
  }
});

app.post('/', requirePermission('tickets:create'), zValidator('json', createCannedResponseSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('cnnd');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({ c, entityType: 'canned_response', entityId: id, action: 'created', data: { id, name: (data as Record<string, unknown>).name, subject: (data as Record<string, unknown>).subject, departmentId: (data as Record<string, unknown>).departmentId } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/canned-responses] create failed:', err);
    return error.internal(c, 'Failed to create canned response');
  }
});

app.patch('/:id', requirePermission('tickets:update'), zValidator('json', updateCannedResponseSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Canned response', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({ c, entityType: 'canned_response', entityId: id, action: 'updated', data: { id, name: (update.name as string | undefined) ?? existing.name, subject: (update.subject as string | undefined) ?? existing.subject, departmentId: (update.departmentId as string | undefined) ?? existing.departmentId } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/canned-responses] update failed:', err);
    return error.internal(c, 'Failed to update canned response');
  }
});

app.delete('/:id', requirePermission('tickets:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Canned response', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'canned_response', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/canned-responses] delete failed:', err);
    return error.internal(c, 'Failed to delete canned response');
  }
});

/**
 * POST /:id/use — render `{{variables}}` into the response and bump usage.
 *
 * Gated at `tickets:read`, matching api-worker's `settings:read`: both are
 * read tiers a MEMBER holds. Inserting a saved reply is a self-scoped action
 * any agent can reach from the picker, so it must NOT sit behind
 * `tickets:update` / `settings:update`. The `usageCount` bump is an internal
 * side effect of reading, not a user-authored edit.
 *
 * No entity event: the events catalog defines `canned_response` with
 * created/updated/deleted only, and api-worker published nothing here either.
 */
app.post('/:id/use', requirePermission('tickets:read'), zValidator('json', useCannedResponseSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { variables = {} } = c.req.valid('json');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Canned response', id);

    const content = interpolateVariables(row.content, variables);
    const subject = row.subject ? interpolateVariables(row.subject, variables) : null;

    await db
      .update(t)
      .set({
        usageCount: sql`COALESCE(${t.usageCount}, 0) + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(t.id, id));

    return success(c, { content, subject, actions: row.actions ?? [] });
  } catch (err) {
    console.error('[app-api/canned-responses] use failed:', err);
    return error.internal(c, 'Failed to use canned response');
  }
});

export const cannedResponsesRoutes = app;
