/**
 * Widget Articles Routes
 *
 * Returns published knowledge base articles for the helpdesk widget.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, like, or, desc, isNull, sql } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { success, paginated, error, createPaginationMeta } from '../lib/response';

// ============================================================================
// Schemas
// ============================================================================

const articleFiltersSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(50).default(20),
  search: z.string().optional(),
  folderId: z.string().optional(),
});

// ============================================================================
// Routes
// ============================================================================

export const articlesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / - List published articles
 *
 * Returns only published and publicly visible articles.
 */
articlesRoutes.get('/', zValidator('query', articleFiltersSchema), async (c) => {
  const filters = c.req.valid('query');

  try {
    const db = c.get('tenantDb');
    const { helpdeskArticles } = schema;

    // Build where conditions - only published, public articles
    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const conditions = [
      eq(helpdeskArticles.status, 'published'),
      eq(helpdeskArticles.visibility, 'public'),
      isNull(helpdeskArticles.deletedAt),
    ];

    if (filters.search) {
      const searchTerm = `%${filters.search}%`;
      conditions.push(
        or(
          like(helpdeskArticles.title, searchTerm),
          like(helpdeskArticles.content, searchTerm),
          like(helpdeskArticles.excerpt, searchTerm)
        )!
      );
    }

    if (filters.folderId) {
      conditions.push(eq(helpdeskArticles.categoryId, filters.folderId));
    }

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(helpdeskArticles)
      .where(and(...conditions));

    const totalCount = countResult[0]?.count || 0;
    const offset = (filters.page - 1) * filters.pageSize;

    // Get paginated results
    const results = await db
      .select({
        id: helpdeskArticles.id,
        title: helpdeskArticles.title,
        slug: helpdeskArticles.slug,
        excerpt: helpdeskArticles.excerpt,
        categoryId: helpdeskArticles.categoryId,
        viewCount: helpdeskArticles.viewCount,
        helpfulCount: helpdeskArticles.helpfulCount,
        notHelpfulCount: helpdeskArticles.notHelpfulCount,
        tags: helpdeskArticles.tags,
        createdAt: helpdeskArticles.createdAt,
        updatedAt: helpdeskArticles.updatedAt,
      })
      .from(helpdeskArticles)
      .where(and(...conditions))
      .orderBy(desc(helpdeskArticles.updatedAt))
      .limit(filters.pageSize)
      .offset(offset);

    const articles = results.map((article) => ({
      id: article.id,
      title: article.title,
      slug: article.slug,
      excerpt: article.excerpt,
      folderId: article.categoryId,
      viewCount: article.viewCount || 0,
      helpfulCount: article.helpfulCount || 0,
      notHelpfulCount: article.notHelpfulCount || 0,
      tags: article.tags || [],
      createdAt: article.createdAt?.toISOString(),
      updatedAt: article.updatedAt?.toISOString(),
    }));

    const pagination = createPaginationMeta(filters.page, filters.pageSize, totalCount);
    return paginated(c, articles, pagination);
  } catch (err) {
    console.error('[Widget] Failed to fetch articles:', err);
    return error.internal(c, 'Failed to fetch articles');
  }
});

/**
 * GET /:id - Get a single article
 *
 * Returns the full content of a published article.
 * Increments the view count.
 */
articlesRoutes.get('/:id', async (c) => {
  const articleId = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const { helpdeskArticles } = schema;

    // Get the article (must be published and public)
    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const results = await db
      .select()
      .from(helpdeskArticles)
      .where(
        and(
          eq(helpdeskArticles.id, articleId),
          eq(helpdeskArticles.status, 'published'),
          eq(helpdeskArticles.visibility, 'public'),
          isNull(helpdeskArticles.deletedAt)
        )
      )
      .limit(1);

    if (results.length === 0) {
      return error.notFound(c, 'Article', articleId);
    }

    const article = results[0];

    // Increment view count
    await db
      .update(helpdeskArticles)
      .set({
        viewCount: sql`${helpdeskArticles.viewCount} + 1`,
      })
      .where(eq(helpdeskArticles.id, articleId));

    return success(c, {
      id: article.id,
      title: article.title,
      slug: article.slug,
      content: article.content,
      excerpt: article.excerpt,
      folderId: article.categoryId,
      viewCount: (article.viewCount || 0) + 1,
      helpfulCount: article.helpfulCount || 0,
      notHelpfulCount: article.notHelpfulCount || 0,
      tags: article.tags || [],
      createdAt: article.createdAt?.toISOString(),
      updatedAt: article.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[Widget] Failed to fetch article:', err);
    return error.internal(c, 'Failed to fetch article');
  }
});

/**
 * GET /slug/:slug - Get article by slug
 *
 * Returns the full content of a published article by its slug.
 */
articlesRoutes.get('/slug/:slug', async (c) => {
  const slug = c.req.param('slug');

  try {
    const db = c.get('tenantDb');
    const { helpdeskArticles } = schema;

    // Get the article by slug
    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const results = await db
      .select()
      .from(helpdeskArticles)
      .where(
        and(
          eq(helpdeskArticles.slug, slug),
          eq(helpdeskArticles.status, 'published'),
          eq(helpdeskArticles.visibility, 'public'),
          isNull(helpdeskArticles.deletedAt)
        )
      )
      .limit(1);

    if (results.length === 0) {
      return error.notFound(c, 'Article');
    }

    const article = results[0];

    // Increment view count
    await db
      .update(helpdeskArticles)
      .set({
        viewCount: sql`${helpdeskArticles.viewCount} + 1`,
      })
      .where(eq(helpdeskArticles.id, article.id));

    return success(c, {
      id: article.id,
      title: article.title,
      slug: article.slug,
      content: article.content,
      excerpt: article.excerpt,
      folderId: article.categoryId,
      viewCount: (article.viewCount || 0) + 1,
      helpfulCount: article.helpfulCount || 0,
      notHelpfulCount: article.notHelpfulCount || 0,
      tags: article.tags || [],
      createdAt: article.createdAt?.toISOString(),
      updatedAt: article.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[Widget] Failed to fetch article by slug:', err);
    return error.internal(c, 'Failed to fetch article');
  }
});
