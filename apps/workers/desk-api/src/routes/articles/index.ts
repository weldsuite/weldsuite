/**
 * Articles routes — flat /api/articles/* surface backed by `helpdesk_articles`.
 *
 * Permissions: articles:read | articles:create | articles:update | articles:delete.
 *
 * Language versions: `GET|POST /:id/translations`. A version is a row with
 * `translationOfId` (the original) and its own locale, at most one per locale
 * per article (checked here, on create and on a locale change).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createArticleSchema,
  createArticleTranslationSchema,
  updateArticleSchema,
} from '@weldsuite/core-api-client/schemas/articles';
import { deskArticleSlug, normalizeDeskLocale } from '@weldsuite/db/lib/desk-articles';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { stripTags } from '@weldsuite/text';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.helpdeskArticles;

/** Pull the article body out of the canonical `content` field or its legacy aliases. */
function pickContent(data: Record<string, unknown>): string | undefined {
  for (const key of ['content', 'body', 'bodyHtml'] as const) {
    const v = data[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}


/**
 * Resolve the folder a write targets. The UI sends `folderId`; the column is
 * `category_id`. We also denormalise the folder's name/path onto the article so
 * list views can show a category without a join. Returns `undefined` when the
 * caller didn't touch folder assignment, `{ categoryId: null, ... }` to clear it.
 */
async function resolveFolder(
  db: Database,
  data: Record<string, unknown>,
): Promise<{ categoryId: string | null; categoryName: string | null; category: string | null } | undefined> {
  const hasFolderId = Object.hasOwn(data, 'folderId');
  const hasCategoryId = Object.hasOwn(data, 'categoryId');
  if (!hasFolderId && !hasCategoryId) return undefined;

  const raw = (hasFolderId ? data.folderId : data.categoryId) as string | null | undefined;
  if (!raw) return { categoryId: null, categoryName: null, category: null };

  const [folder] = await db
    .select({ name: schema.helpdeskArticleFolders.name, path: schema.helpdeskArticleFolders.path })
    .from(schema.helpdeskArticleFolders)
    .where(eq(schema.helpdeskArticleFolders.id, raw))
    .limit(1);

  return {
    categoryId: raw,
    categoryName: folder?.name ?? null,
    category: folder?.path ?? folder?.name ?? null,
  };
}

/**
 * Why `article` can't have `locale`: a version needs one, and no other live
 * version of the same article may have it. Null when it can.
 */
async function localeConflict(
  db: Database,
  article: { id: string; translationOfId: string | null },
  locale: string | null,
): Promise<string | null> {
  if (article.translationOfId && !locale) return 'A language version needs a language';
  if (!locale) return null;
  const rootId = article.translationOfId ?? article.id;
  const [taken] = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        isNull(t.deletedAt),
        sql`(${t.id} = ${rootId} or ${t.translationOfId} = ${rootId})`,
        sql`${t.id} <> ${article.id}`,
        eq(t.locale, locale),
      ),
    )
    .limit(1);
  return taken ? 'This article already has a version in that language' : null;
}

app.get('/', requirePermission('articles:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (q.status) conditions.push(eq(t.status, q.status));
  if (q.visibility) conditions.push(eq(t.visibility, q.visibility));
  if (q.folderId) conditions.push(eq(t.categoryId, q.folderId));
  if (q.authorId) conditions.push(eq(t.authorId, q.authorId));
  if (q.originals) conditions.push(isNull(t.translationOfId));
  if (q.search) {
    conditions.push(like(t.title, `%${q.search}%`));
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
  const where = and(...conditions);
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(and(...filterConditions)),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/articles] list failed:', err);
    return error.internal(c, 'Failed to list articles');
  }
});

app.get('/:id', requirePermission('articles:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'Article', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/articles] get failed:', err);
    return error.internal(c, 'Failed to fetch article');
  }
});

app.post('/', requirePermission('articles:create'), zValidator('json', createArticleSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const userId = c.get('userId');
  const id = generateId('art');
  const now = new Date();

  const content = pickContent(data) ?? '';
  const title = String(data.title);
  const slug = deskArticleSlug(typeof data.slug === 'string' && data.slug.length > 0 ? data.slug : title) || id;
  const authorId = typeof data.authorId === 'string' && data.authorId.length > 0 ? data.authorId : userId;
  const status = (data.status as string | undefined) ?? 'draft';
  const isPublished = status === 'published';

  const insert: Record<string, any> = {
    id,
    title,
    slug: `${slug}-${id.slice(4, 10)}`,
    content,
    excerpt: typeof data.excerpt === 'string' ? data.excerpt : stripTags(content).slice(0, 200),
    status,
    visibility: (data.visibility as string | undefined) ?? 'public',
    audienceCompanyIds: (data.audienceCompanyIds as string[] | undefined) ?? [],
    locale: normalizeDeskLocale(data.locale as string | null | undefined),
    tags: data.tags,
    authorId,
    authorName: data.authorName,
    isDraft: !isPublished,
    publishedAt: isPublished ? now : null,
    viewCount: 0,
    helpfulCount: 0,
    notHelpfulCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const folder = await resolveFolder(db, data);
  if (folder) Object.assign(insert, folder);

  try {
    await db.insert(t).values(insert as unknown as typeof t.$inferInsert);
    publishEntityEvent({ c, entityType: 'helpdesk_article', entityId: id, action: 'created', data: { id, title, slug, status, authorId } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/articles] create failed:', err);
    return error.internal(c, 'Failed to create article');
  }
});

app.patch('/:id', requirePermission('articles:update'), zValidator('json', updateArticleSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Article', id);

    const now = new Date();
    const update: Record<string, any> = { updatedAt: now };

    // Scalar fields the caller may set directly.
    for (const key of ['title', 'slug', 'excerpt', 'visibility', 'audienceCompanyIds', 'tags', 'authorName'] as const) {
      if (data[key] !== undefined) update[key] = data[key];
    }

    // The article's language: one version per locale, and a version keeps one.
    if (data.locale !== undefined) {
      const locale = normalizeDeskLocale(data.locale as string | null);
      if (locale !== existing.locale) {
        const conflict = await localeConflict(db, existing, locale);
        if (conflict) return error.conflict(c, conflict);
      }
      update.locale = locale;
    }

    const content = pickContent(data);
    if (content !== undefined) update.content = content;

    // Folder reassignment (folderId/categoryId → category_id + denormalised name).
    const folder = await resolveFolder(db, data);
    if (folder) Object.assign(update, folder);

    // Publish lifecycle: stamp publishedAt / unpublishedAt and the isDraft flag
    // when the status actually transitions across the published boundary.
    if (data.status !== undefined && data.status !== existing.status) {
      update.status = data.status;
      const becomingPublished = data.status === 'published';
      const wasPublished = existing.status === 'published';
      if (becomingPublished && !wasPublished) {
        update.publishedAt = now;
        update.unpublishedAt = null;
        update.isDraft = false;
      } else if (!becomingPublished && wasPublished) {
        update.unpublishedAt = now;
        update.isDraft = true;
      }
    }

    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({ c, entityType: 'helpdesk_article', entityId: id, action: 'updated', data: { id, title: (update.title as string | undefined) ?? existing.title, slug: (update.slug as string | undefined) ?? existing.slug, status: (update.status as string | undefined) ?? existing.status } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/articles] update failed:', err);
    return error.internal(c, 'Failed to update article');
  }
});

app.delete('/:id', requirePermission('articles:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Article', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({ c, entityType: 'helpdesk_article', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/articles] delete failed:', err);
    return error.internal(c, 'Failed to delete article');
  }
});

// ============================================================================
// Language versions
// ============================================================================

/** The article family `id` belongs to: its original, or 404 when either is gone. */
async function originalOf(db: Database, id: string) {
  const [found] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
  if (!found?.translationOfId) return found ?? null;
  const [original] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, found.translationOfId), isNull(t.deletedAt)))
    .limit(1);
  return original ?? null;
}

app.get('/:id/translations', requirePermission('articles:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const original = await originalOf(db, id);
    if (!original) return error.notFound(c, 'Article', id);
    const rows = await db
      .select({
        id: t.id,
        title: t.title,
        slug: t.slug,
        status: t.status,
        visibility: t.visibility,
        locale: t.locale,
        translationOfId: t.translationOfId,
        updatedAt: t.updatedAt,
      })
      .from(t)
      .where(and(isNull(t.deletedAt), sql`(${t.id} = ${original.id} or ${t.translationOfId} = ${original.id})`))
      .orderBy(sql`(${t.translationOfId} is not null)`, sql`${t.locale} asc nulls first`, t.id);
    return success(c, rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })));
  } catch (err) {
    console.error('[app-api/articles] translations failed:', err);
    return error.internal(c, 'Failed to list language versions');
  }
});

app.post(
  '/:id/translations',
  requirePermission('articles:create'),
  zValidator('json', createArticleTranslationSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const original = await originalOf(db, id);
      if (!original) return error.notFound(c, 'Article', id);
      const locale = normalizeDeskLocale(data.locale);
      const conflict = await localeConflict(db, { id: '', translationOfId: original.id }, locale);
      if (conflict) return error.conflict(c, conflict);

      const newId = generateId('art');
      const now = new Date();
      const title = data.title ?? original.title;
      const slug = `${deskArticleSlug(title) || newId}-${newId.slice(4, 10)}`;
      const authorId = c.get('userId');
      await db.insert(t).values({
        id: newId,
        title,
        slug,
        content: data.content ?? original.content,
        excerpt: data.excerpt ?? original.excerpt,
        category: original.category,
        categoryId: original.categoryId,
        categoryName: original.categoryName,
        status: 'draft',
        visibility: original.visibility,
        audienceCompanyIds: original.audienceCompanyIds ?? [],
        locale,
        translationOfId: original.id,
        tags: original.tags,
        authorId,
        isDraft: true,
        publishedAt: null,
        viewCount: 0,
        helpfulCount: 0,
        notHelpfulCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      publishEntityEvent({
        c,
        entityType: 'helpdesk_article',
        entityId: newId,
        action: 'created',
        data: { id: newId, title, slug, status: 'draft', authorId, translationOfId: original.id, locale },
      });
      return success(c, { id: newId }, 201);
    } catch (err) {
      console.error('[app-api/articles] create translation failed:', err);
      return error.internal(c, 'Failed to create the language version');
    }
  },
);

export const articlesRoutes = app;
