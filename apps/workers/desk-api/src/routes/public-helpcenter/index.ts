/**
 * Public Help Center routes — /public/helpcenter/* surface.
 *
 * UNAUTHENTICATED. Mounted OUTSIDE the /api/* Clerk guard. The tenant database
 * is resolved from the incoming `?domain=` param via helpcenterDomainMiddleware,
 * not from a Clerk org.
 *
 * Readers: anonymous, or signed in when the help center's server forwards the
 * portal session (`x-portal-session`, see @weldsuite/db/lib/desk-portal-session).
 * Only published articles the reader may open are served (public; logged_in
 * when signed in; groups when the reader's CRM company is in the audience),
 * one entry per article in the reader's language (`?locale=`) when it has a
 * version in it. Search is Postgres full-text search (@weldsuite/db/lib/desk-articles).
 *
 * Consumed by the apps/web/helpcenter renderer; it never edge-caches a
 * response it sent a session for.
 */

import { Hono, type Context } from 'hono';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  DESK_ANONYMOUS_READER,
  deskArticleFolderId,
  deskArticleLiveFor,
  deskArticleMatches,
  deskArticleRank,
  deskDisplayedArticleIds,
  deskReaderOf,
  deskTypedSearch,
  findDeskReadableArticle,
  listDeskAnnouncementsFor,
  listDeskArticleVersionLinks,
  normalizeDeskLocale,
  type DeskReader,
} from '@weldsuite/db/lib/desk-articles';
import { DESK_PORTAL_SESSION_HEADER, deskPortalPrincipal } from '@weldsuite/db/lib/desk-portal-session';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { helpcenterDomainMiddleware } from '../../middleware/helpcenter-domain';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Resolve tenant DB by domain for every public route.
app.use('*', helpcenterDomainMiddleware());

const PAGE_SIZE_MAX = 50;

function parsePaging(q: Record<string, string>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(Number.parseInt(q.page ?? '1', 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(q.pageSize ?? '20', 10) || 20, 1), PAGE_SIZE_MAX);
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
    if (!config?.isEnabled) {
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
// The reader
// ============================================================================

/**
 * Who is reading: anonymous, or the signed-in help-center reader whose portal
 * session the help center's server forwarded (`x-portal-session`). An
 * unknown, expired or foreign session reads as anonymous, never as an error.
 */
async function readerOf(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<DeskReader> {
  const token = c.req.header(DESK_PORTAL_SESSION_HEADER);
  if (!token) return DESK_ANONYMOUS_READER;
  const db = c.get('tenantDb');
  const principal = await deskPortalPrincipal(db, c.env.WORKSPACE_CACHE, c.get('workspaceId'), token);
  return deskReaderOf(db, principal);
}

/** `?locale=`: the reader's language, null when none was given. */
function localeOf(q: Record<string, string>): string | null {
  return normalizeDeskLocale(q.locale?.slice(0, 10));
}

const t = schema.helpdeskArticles;

/** What a list shows of an article. */
const summaryColumns = {
  id: t.id,
  title: t.title,
  slug: t.slug,
  excerpt: t.excerpt,
  folderId: deskArticleFolderId,
  locale: t.locale,
  viewCount: t.viewCount,
  helpfulCount: t.helpfulCount,
  notHelpfulCount: t.notHelpfulCount,
  tags: t.tags,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
};

// ============================================================================
// GET /folders — category tree
// ============================================================================

app.get('/folders', async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskArticleFolders } = schema;
  try {
    const reader = await readerOf(c);
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
      // Live count of the articles the reader may open per folder (one per
      // article, whatever its language versions), for the category cards.
      db
        .select({ categoryId: t.categoryId, count: sql<number>`count(*)::int` })
        .from(t)
        .where(and(isNull(t.translationOfId), deskArticleLiveFor('helpdesk_articles', reader)))
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
// GET /articles — the reader's articles, one per article (page-based)
// ============================================================================

app.get('/articles', async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const { page, pageSize, offset } = parsePaging(q);
  try {
    const reader = await readerOf(c);
    const search = q.search ? deskTypedSearch(q.search) : null;
    const conditions = [sql`${t.id} in ${deskDisplayedArticleIds(reader, localeOf(q), q.folderId || null)}`];
    if (search) conditions.push(deskArticleMatches('helpdesk_articles', search));

    const [countRes, rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...conditions)),
      db.select(summaryColumns).from(t).where(and(...conditions)).orderBy(desc(t.updatedAt), desc(t.id)).limit(pageSize).offset(offset),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    const data = rows.map((a) => ({
      id: a.id, title: a.title, slug: a.slug, excerpt: a.excerpt, folderId: a.folderId, locale: a.locale,
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
// GET /articles/:slug — one article the reader may open (bumps viewCount),
// with its language versions
// ============================================================================

app.get('/articles/:slug', async (c) => {
  const db = c.get('tenantDb');
  const slug = c.req.param('slug');
  try {
    const reader = await readerOf(c);
    const article = await findDeskReadableArticle(db, slug, reader);
    if (!article) return error.notFound(c, 'Article');

    await db.update(t).set({ viewCount: sql`${t.viewCount} + 1` }).where(eq(t.id, article.id));

    const rootId = article.translationOfId ?? article.id;
    const [versions, folder] = await Promise.all([
      listDeskArticleVersionLinks(db, rootId, reader),
      article.translationOfId
        ? db.select({ categoryId: t.categoryId }).from(t).where(eq(t.id, article.translationOfId)).limit(1)
        : Promise.resolve([{ categoryId: article.categoryId }]),
    ]);

    return success(c, {
      id: article.id, title: article.title, slug: article.slug, content: article.content, excerpt: article.excerpt,
      folderId: folder[0]?.categoryId ?? null, locale: article.locale, viewCount: (article.viewCount ?? 0) + 1,
      helpfulCount: article.helpfulCount ?? 0, notHelpfulCount: article.notHelpfulCount ?? 0,
      tags: article.tags ?? [], createdAt: article.createdAt?.toISOString(), updatedAt: article.updatedAt?.toISOString(),
      versions,
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
// GET /search — full-text over the reader's articles (page-based)
// ============================================================================

app.get('/search', async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const search = deskTypedSearch(q.q ?? '');
  if (!search) return c.json({ data: [], pagination: pageMeta(1, 20, 0) });
  const { page, pageSize, offset } = parsePaging(q);
  try {
    const reader = await readerOf(c);
    const conditions = [
      sql`${t.id} in ${deskDisplayedArticleIds(reader, localeOf(q))}`,
      deskArticleMatches('helpdesk_articles', search),
    ];
    const [countRes, rows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...conditions)),
      db
        .select({ id: t.id, title: t.title, slug: t.slug, excerpt: t.excerpt, folderId: deskArticleFolderId, locale: t.locale, tags: t.tags, updatedAt: t.updatedAt })
        .from(t)
        .where(and(...conditions))
        .orderBy(desc(deskArticleRank('helpdesk_articles', search)), desc(t.updatedAt), desc(t.id))
        .limit(pageSize)
        .offset(offset),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    const data = rows.map((a) => ({
      id: a.id, title: a.title, slug: a.slug, excerpt: a.excerpt, folderId: a.folderId, locale: a.locale,
      tags: a.tags ?? [], updatedAt: a.updatedAt?.toISOString(),
    }));
    return c.json({ data, pagination: pageMeta(page, pageSize, totalCount) });
  } catch (err) {
    console.error('[app-api/public-helpcenter] search failed:', err);
    return error.internal(c, 'Search failed');
  }
});

// ============================================================================
// GET /announcements — the reader's status banners
// ============================================================================

app.get('/announcements', async (c) => {
  const db = c.get('tenantDb');
  try {
    return success(c, await listDeskAnnouncementsFor(db, await readerOf(c)));
  } catch (err) {
    console.error('[app-api/public-helpcenter] announcements failed:', err);
    return error.internal(c, 'Failed to fetch announcements');
  }
});

export const publicHelpcenterRoutes = app;
