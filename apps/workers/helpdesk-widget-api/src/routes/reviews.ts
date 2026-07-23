/**
 * Widget Reviews Routes
 *
 * Allows customers to rate articles as helpful or not helpful.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { success, error } from '../lib/response';
import { publishEntityEvent } from '../lib/entity-events';

// ============================================================================
// Schemas
// ============================================================================

const articleReviewSchema = z.object({
  helpful: z.boolean(),
  feedback: z.string().max(1000).optional(),
});

// ============================================================================
// Routes
// ============================================================================

export const reviewsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /articles/:articleId - Submit article review
 *
 * Allows customers to rate an article as helpful or not helpful.
 */
reviewsRoutes.post('/articles/:articleId', zValidator('json', articleReviewSchema), async (c) => {
  const articleId = c.req.param('articleId');
  const data = c.req.valid('json');

  try {
    const db = c.get('tenantDb');
    const { helpdeskArticles } = schema;

    // Verify article exists and is published
    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const articleResults = await db
      .select({ id: helpdeskArticles.id })
      .from(helpdeskArticles)
      .where(
        and(
          eq(helpdeskArticles.id, articleId),
          eq(helpdeskArticles.status, 'published'),
          isNull(helpdeskArticles.deletedAt)
        )
      )
      .limit(1);

    if (articleResults.length === 0) {
      return error.notFound(c, 'Article', articleId);
    }

    // Update the helpful/not helpful count
    if (data.helpful) {
      await db
        .update(helpdeskArticles)
        .set({
          helpfulCount: sql`${helpdeskArticles.helpfulCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(helpdeskArticles.id, articleId));
    } else {
      await db
        .update(helpdeskArticles)
        .set({
          notHelpfulCount: sql`${helpdeskArticles.notHelpfulCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(helpdeskArticles.id, articleId));
    }

    console.log(`[Widget] Article ${articleId} reviewed: helpful=${data.helpful}`);

    // Publish entity event for article review creation
    publishEntityEvent({
      c,
      entityType: 'helpdesk_review',
      entityId: articleId,
      action: 'created',
      data: {
        id: articleId,
        articleId,
        helpful: data.helpful,
        feedback: data.feedback || '',
      },
    });

    return success(c, {
      articleId,
      helpful: data.helpful,
      message: 'Thank you for your feedback!',
    }, 201);
  } catch (err) {
    console.error('[Widget] Failed to submit article review:', err);
    return error.internal(c, 'Failed to submit review');
  }
});
