import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, like, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import {
  createArticleSchema,
  updateArticleSchema,
} from '@weldsuite/core-api-client/schemas/articles';

const listArticlesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  search: z.string().optional(),
  status: z.string().optional(),
  authorId: z.string().optional(),
});

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 500);
}

/** content/body/bodyHtml → the NOT NULL `content` column. */
function deriveContent(body: { content?: string; body?: string; bodyHtml?: string }): string | undefined {
  return body.content || body.body || body.bodyHtml || undefined;
}

const table = schema.helpdeskArticles;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('articles:read'), zValidator('query', listArticlesQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.search) where.push(like(table.title, `%${q.search}%`));
  if (q.status) where.push(eq(table.status, q.status));
  if (q.authorId) where.push(eq(table.authorId, q.authorId));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope('articles:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Article', id);
  return success(c, row);
});

app.post('/', requireScope('articles:write'), zValidator('json', createArticleSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  // content, slug and authorId are NOT NULL with no DB default.
  const authorId = body.authorId ?? c.get('apiSession').userId;
  if (!authorId) return error.badRequest(c, 'authorId is required for workspace API keys');
  const now = new Date();
  const id = generateId('art');
  const values = {
    ...(body as Record<string, unknown>),
    id,
    content: deriveContent(body) ?? '',
    slug: body.slug || slugify(body.title) || id,
    authorId,
    createdAt: now,
    updatedAt: now,
  };
  const [row] = await db.insert(table).values(values as typeof table.$inferInsert).returning();
  if (!row) return error.internal(c, 'Failed to create article');
  publishEntityEvent({
    c,
    entityType: 'helpdesk_article',
    entityId: id,
    action: 'created',
    data: { id, title: row.title, slug: row.slug, status: row.status, authorId: row.authorId },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('articles:write'), zValidator('json', updateArticleSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const update: Record<string, unknown> = { ...(body as Record<string, unknown>), updatedAt: new Date() };
  const content = deriveContent(body);
  if (content !== undefined) update.content = content;
  const [row] = await db
    .update(table)
    .set(update)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Article', id);
  publishEntityEvent({
    c,
    entityType: 'helpdesk_article',
    entityId: id,
    action: 'updated',
    data: { id, title: row.title, slug: row.slug, status: row.status },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('articles:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'Article', id);
  publishEntityEvent({ c, entityType: 'helpdesk_article', entityId: id, action: 'deleted', data: { id } });
  return noContent(c);
});

export default app;
