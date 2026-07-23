/**
 * Public Help Center routes — /public/helpcenter/* surface.
 *
 * UNAUTHENTICATED. Mounted OUTSIDE the /api/* Clerk guard. The tenant database
 * is resolved from the incoming `?domain=` param via helpcenterDomainMiddleware,
 * not from a Clerk org. Only `published` + `public` articles are ever served.
 *
 * Consumed by the apps/web/helpcenter Next.js renderer.
 */

import { Hono } from 'hono';
import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import { helpcenterDomainMiddleware } from '../../middleware/helpcenter-domain';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Resolve tenant DB by domain for every public route.
app.use('*', helpcenterDomainMiddleware());

const PAGE_SIZE_MAX = 50;

function parsePaging(q: Record<string, string>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(parseInt(q.page ?? '1', 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(q.pageSize ?? '20', 10) || 20, 1), PAGE_SIZE_MAX);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pageMeta(page: number, pageSize: number, totalCount: number) {
  const totalPages = Math.ceil(totalCount / pageSize);
  return { page, pageSize, totalCount, totalPages, hasMore: page < totalPages };
}

// ============================================================================
// GET /config — branding / SEO (only when enabled)
// ============================================================================

app.get('/config', async (c) => {
  const db = c.get('tenantDb');
  const { helpcenterSettings } = schema;
  try {
    const [config] = await db
      .select()
      .from(helpcenterSettings)
      .where(isNull(helpcenterSettings.deletedAt))
      .orderBy(asc(helpcenterSettings.createdAt), asc(helpcenterSettings.id))
      .limit(1);
    if (!config || !config.isEnabled) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Help center is not enabled' } }, 404);
    }
    return success(c, {
      siteName: config.siteName,
      logo: config.logo,
      logoDark: config.logoDark,
      favicon: config.favicon,
      primaryColor: config.primaryColor,
      accentColor: config.accentColor,
      heroTitle: config.heroTitle,
      heroSubtitle: config.heroSubtitle,
      showSearch: config.showSearch,
      showCategories: config.showCategories,
      metaTitle: config.metaTitle,
      metaDescription: config.metaDescription,
      ogImage: config.ogImage,
      footerText: config.footerText,
      socialLinks: config.socialLinks,
      customCss: config.customCss,
      googleAnalyticsId: config.googleAnalyticsId,
    });
  } catch (err) {
    console.error('[app-api/public-helpcenter] config failed:', err);
    return error.internal(c, 'Failed to fetch help center configuration');
  }
});

// ============================================================================
// GET /folders — category tree
// ============================================================================

app.get('/folders', async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskArticleFolders } = schema;
  const t = schema.helpdeskArticles;
  try {
    const [rows, counts] = await Promise.all([
      db
        .select({
          id: helpdeskArticleFolders.id,
          name: helpdeskArticleFolders.name,
          parentId: helpdeskArticleFolders.parentId,
          sortOrder: helpdeskArticleFolders.sortOrder,
          icon: helpdeskArticleFolders.icon,
          description: helpdeskArticleFolders.description,
        })
        .from(helpdeskArticleFolders)
        .where(isNull(helpdeskArticleFolders.deletedAt))
        .orderBy(helpdeskArticleFolders.sortOrder),
      // Live count of published + public articles per folder, so category cards
      // can show an accurate article count.
      db
        .select({ categoryId: t.categoryId, count: sql<number>`count(*)::int` })
        .from(t)
        .where(and(eq(t.status, 'published'), eq(t.visibility, 'public'), isNull(t.deletedAt)))
        .groupBy(t.categoryId),
    ]);
    const countMap = new Map(counts.map((r) => [r.categoryId, Number(r.count)]));
    return success(
      c,
      rows.map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId,
        sortOrder: f.sortOrder ?? 0,
        icon: f.icon ?? null,
        description: f.description ?? null,
        articleCount: countMap.get(f.id) ?? 0,
      })),
    );
  } catch (err) {
    console.error('[app-api/public-helpcenter] folders failed:', err);
    return error.internal(c, 'Failed to fetch folders');
  }
});

// ============================================================================
// GET /articles — published + public list (page-based)
// ============================================================================

app.get('/articles', async (c) => {
  const db = c.get('tenantDb');
  const t = schema.helpdeskArticles;
  const q = c.req.query();
  const { page, pageSize, offset } = parsePaging(q);
  try {
    const conditions = [eq(t.status, 'published'), eq(t.visibility, 'public'), isNull(t.deletedAt)];
    if (q.search) {
      conditions.push(or(like(t.title, `%${q.search}%`), like(t.content, `%${q.search}%`), like(t.excerpt, `%${q.search}%`))!);
    }
    if (q.folderId) conditions.push(eq(t.categoryId, q.folderId));

    const [countRes, rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...conditions)),
      db
        .select({
          id: t.id, title: t.title, slug: t.slug, excerpt: t.excerpt, categoryId: t.categoryId,
          viewCount: t.viewCount, helpfulCount: t.helpfulCount, notHelpfulCount: t.notHelpfulCount,
          tags: t.tags, createdAt: t.createdAt, updatedAt: t.updatedAt,
        })
        .from(t).where(and(...conditions)).orderBy(desc(t.updatedAt)).limit(pageSize).offset(offset),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    const data = rows.map((a) => ({
      id: a.id, title: a.title, slug: a.slug, excerpt: a.excerpt, folderId: a.categoryId,
      viewCount: a.viewCount ?? 0, helpfulCount: a.helpfulCount ?? 0, notHelpfulCount: a.notHelpfulCount ?? 0,
      tags: a.tags ?? [], createdAt: a.createdAt?.toISOString(), updatedAt: a.updatedAt?.toISOString(),
    }));
    return c.json({ data, pagination: pageMeta(page, pageSize, totalCount) });
  } catch (err) {
    console.error('[app-api/public-helpcenter] articles failed:', err);
    return error.internal(c, 'Failed to fetch articles');
  }
});

// ============================================================================
// GET /articles/:slug — single published + public article (bumps viewCount)
// ============================================================================

app.get('/articles/:slug', async (c) => {
  const db = c.get('tenantDb');
  const t = schema.helpdeskArticles;
  const slug = c.req.param('slug');
  try {
    const [article] = await db
      .select()
      .from(t)
      .where(and(eq(t.slug, slug), eq(t.status, 'published'), eq(t.visibility, 'public'), isNull(t.deletedAt)))
      .limit(1);
    if (!article) return error.notFound(c, 'Article');

    await db.update(t).set({ viewCount: sql`${t.viewCount} + 1` }).where(eq(t.id, article.id));

    return success(c, {
      id: article.id, title: article.title, slug: article.slug, content: article.content, excerpt: article.excerpt,
      folderId: article.categoryId, viewCount: (article.viewCount ?? 0) + 1,
      helpfulCount: article.helpfulCount ?? 0, notHelpfulCount: article.notHelpfulCount ?? 0,
      tags: article.tags ?? [], createdAt: article.createdAt?.toISOString(), updatedAt: article.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/public-helpcenter] article failed:', err);
    return error.internal(c, 'Failed to fetch article');
  }
});

// ============================================================================
// POST /articles/:id/feedback — helpful / not helpful
// ============================================================================

app.post('/articles/:id/feedback', async (c) => {
  const db = c.get('tenantDb');
  const t = schema.helpdeskArticles;
  const id = c.req.param('id');
  let helpful = false;
  try {
    const body = (await c.req.json()) as { helpful?: unknown };
    helpful = body.helpful === true;
  } catch {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid body' } }, 400);
  }
  try {
    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, id), eq(t.status, 'published'), isNull(t.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Article', id);

    await db
      .update(t)
      .set(helpful ? { helpfulCount: sql`${t.helpfulCount} + 1` } : { notHelpfulCount: sql`${t.notHelpfulCount} + 1` })
      .where(eq(t.id, id));
    return success(c, { recorded: true });
  } catch (err) {
    console.error('[app-api/public-helpcenter] feedback failed:', err);
    return error.internal(c, 'Failed to record feedback');
  }
});

// ============================================================================
// GET /search — full-text over published + public articles (page-based)
// ============================================================================

app.get('/search', async (c) => {
  const db = c.get('tenantDb');
  const t = schema.helpdeskArticles;
  const q = c.req.query();
  const term = (q.q ?? '').trim();
  if (!term) return c.json({ data: [], pagination: pageMeta(1, 20, 0) });
  const { page, pageSize, offset } = parsePaging(q);
  try {
    const searchTerm = `%${term}%`;
    const conditions = [
      eq(t.status, 'published'),
      eq(t.visibility, 'public'),
      isNull(t.deletedAt),
      or(like(t.title, searchTerm), like(t.content, searchTerm), like(t.excerpt, searchTerm))!,
    ];
    const [countRes, rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...conditions)),
      db
        .select({ id: t.id, title: t.title, slug: t.slug, excerpt: t.excerpt, categoryId: t.categoryId, tags: t.tags, updatedAt: t.updatedAt })
        .from(t).where(and(...conditions)).orderBy(desc(t.updatedAt)).limit(pageSize).offset(offset),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    const data = rows.map((a) => ({
      id: a.id, title: a.title, slug: a.slug, excerpt: a.excerpt, folderId: a.categoryId,
      tags: a.tags ?? [], updatedAt: a.updatedAt?.toISOString(),
    }));
    return c.json({ data, pagination: pageMeta(page, pageSize, totalCount) });
  } catch (err) {
    console.error('[app-api/public-helpcenter] search failed:', err);
    return error.internal(c, 'Search failed');
  }
});

export const publicHelpcenterRoutes = app;
