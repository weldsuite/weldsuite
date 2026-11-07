/**
 * GitHub connection routes — flat /api/github-connections/* surface, backed by the workspace's
 * WeldMerge GitHub connections (`merge_connections`, provider `github`). Rows are mapped to the
 * shape these routes always answered (`installationId` as a number, `ownerType`, `ownerLogin`,
 * `createdBy`, …) by `toGithubConnection`; a body in that shape is mapped back to the columns.
 *
 * Permissions: integrations:read | integrations:create | integrations:update | integrations:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { createGithubConnectionSchema, updateGithubConnectionSchema } from '@weldsuite/core-api-client/schemas/github-connections';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { parseLimit } from '../../lib/query-params';
import { toGithubConnection } from '../../services/github/connections';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.mergeConnections;

/** What a stored row answers: the legacy shape, without the webhook secret. */
const present = (row: typeof t.$inferSelect, workspaceId: string) => ({ ...toGithubConnection(row, workspaceId), webhookSecret: undefined });

/**
 * A body in the legacy shape as `merge_connections` columns. Unknown keys are dropped; a value of
 * the wrong type reaches the column and the write fails, as it always did.
 */
function toColumns(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (data.installationId !== undefined && data.installationId !== null) out.externalAccountId = String(data.installationId);
  if (data.appSlug !== undefined) out.appSlug = data.appSlug;
  if (data.ownerType !== undefined) out.accountType = data.ownerType === 'org' ? 'organization' : data.ownerType;
  const login = data.ownerLogin ?? data.accountLogin;
  if (login !== undefined) out.accountLogin = login;
  for (const key of ['status', 'scopes', 'installedAt', 'revokedAt', 'webhookSecret'] as const) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

app.get('/', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = parseLimit(q.limit, 25, 100);

  const conditions: any[] = [isNull(t.deletedAt), eq(t.provider, 'github')];
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status as never));
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
    // Never expose the per-installation webhook secret to `integrations:read` holders.
    const safe = data.map((r) => present(r, c.get('clerkOrgId') ?? ''));
    return list(c, safe, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/github-connections] list failed:', err);
    return error.internal(c, 'Failed to list github connections');
  }
});

app.get('/:id', requirePermission('integrations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), eq(t.provider, 'github'), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'GitHub connection', id);
    return success(c, present(row, c.get('clerkOrgId') ?? ''));
  } catch (err) {
    console.error('[app-api/github-connections] get failed:', err);
    return error.internal(c, 'Failed to fetch github connection');
  }
});

app.post('/', requirePermission('integrations:create'), zValidator('json', createGithubConnectionSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('ghc');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      provider: 'github',
      createdByUserId: c.get('userId'),
      ...toColumns(data),
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/github-connections] create failed:', err);
    return error.internal(c, 'Failed to create github connection');
  }
});

app.patch('/:id', requirePermission('integrations:update'), zValidator('json', updateGithubConnectionSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), eq(t.provider, 'github'), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'GitHub connection', id);
    await db
      .update(t)
      .set({ ...toColumns(data), updatedAt: new Date() })
      .where(and(eq(t.id, id), isNull(t.deletedAt)));
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/github-connections] update failed:', err);
    return error.internal(c, 'Failed to update github connection');
  }
});

app.delete('/:id', requirePermission('integrations:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), eq(t.provider, 'github'), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'GitHub connection', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/github-connections] delete failed:', err);
    return error.internal(c, 'Failed to delete github connection');
  }
});

export const githubConnectionsRoutes = app;
