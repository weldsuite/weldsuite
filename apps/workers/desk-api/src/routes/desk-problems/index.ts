/**
 * WeldDesk problem management, /api/desk/problems: the cause behind one or
 * more incidents (inbox conversations), with its root cause, workaround and
 * known-error status.
 *
 *   GET    /                        list (status, knownErrors, assigneeId, departmentId, q, cursor, limit)
 *   POST   /                        create, optionally linking incidents
 *   GET    /:id                     one problem with its incident counts
 *   PATCH  /:id                     edit; the status moves the timestamps
 *   DELETE /:id                     delete; its incidents are unlinked
 *   GET    /:id/conversations       the linked incidents
 *   POST   /:id/share-workaround    a note or reply on every open incident
 *   POST   /:id/article             a draft internal article from the problem
 *
 * Writes go through @weldsuite/db/lib/desk-problems (the rules are there).
 * Timeline entries on incidents are published like the link routes publish
 * theirs. Permissions: problems:read | create | update | delete, and
 * articles:create for the article.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createDeskProblemSchema,
  listDeskProblemConversationsQuerySchema,
  listDeskProblemsQuerySchema,
  shareDeskProblemWorkaroundSchema,
  updateDeskProblemSchema,
} from '@weldsuite/core-api-client/schemas/desk-problems';
import { DeskConversationNotFoundError } from '@weldsuite/db/lib/desk';
import { deskArticleSlug } from '@weldsuite/db/lib/desk-articles';
import {
  createDeskProblem,
  deleteDeskProblem,
  deskArticleDraftFromProblem,
  DeskProblemFieldError,
  DeskProblemNotFoundError,
  DeskProblemRejectedError,
  getDeskProblem,
  listDeskProblemConversations,
  listDeskProblems,
  setDeskProblemArticle,
  shareDeskProblemWorkaround,
  updateDeskProblem,
} from '@weldsuite/db/lib/desk-problems';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { sendDeskEmailReply } from '../../lib/desk-email';
import { publishDeskLinkChanges } from '../desk-conversations/links';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const articles = schema.helpdeskArticles;

/** The answer to a refusal, a missing record or a failure. */
function refusal(c: Ctx, err: unknown, failure: string) {
  if (err instanceof DeskProblemNotFoundError) return error.notFound(c, 'Problem', err.problemId);
  if (err instanceof DeskConversationNotFoundError) return error.notFound(c, 'Conversation', err.conversationId);
  if (err instanceof DeskProblemRejectedError) return error.conflict(c, err.message, { reason: err.reason });
  if (err instanceof DeskProblemFieldError) return error.badRequest(c, err.message, { field: err.field });
  console.error(`[desk-api/desk-problems] ${failure}:`, err);
  return error.internal(c, failure);
}

app.get('/', requirePermission('problems:read'), zValidator('query', listDeskProblemsQuerySchema), async (c) => {
  const { status, ...query } = c.req.valid('query');
  try {
    const result = await listDeskProblems(c.get('tenantDb'), { ...query, statuses: status });
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    return refusal(c, err, 'Failed to list problems');
  }
});

app.post('/', requirePermission('problems:create'), zValidator('json', createDeskProblemSchema), async (c) => {
  const input = c.req.valid('json');
  try {
    const result = await createDeskProblem(c.get('tenantDb'), {
      ...input,
      generateId,
      authorId: c.get('userId'),
    });
    publishEntityEvent({
      c,
      entityType: 'desk_problem',
      action: 'created',
      entityId: result.problem.id,
      data: result.problem as unknown as Record<string, unknown>,
    });
    await publishDeskLinkChanges(c, result.changes);
    return success(c, { problem: result.problem, messages: result.changes.map((change) => change.message) }, 201);
  } catch (err) {
    return refusal(c, err, 'Failed to create the problem');
  }
});

app.get('/:id', requirePermission('problems:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const problem = await getDeskProblem(c.get('tenantDb'), id);
    if (!problem) return error.notFound(c, 'Problem', id);
    return success(c, problem);
  } catch (err) {
    return refusal(c, err, 'Failed to load the problem');
  }
});

app.patch('/:id', requirePermission('problems:update'), zValidator('json', updateDeskProblemSchema), async (c) => {
  const id = c.req.param('id');
  try {
    const { problem, changes } = await updateDeskProblem(c.get('tenantDb'), {
      id,
      authorId: c.get('userId'),
      patch: c.req.valid('json'),
    });
    if (Object.keys(changes).length > 0) {
      publishEntityEvent({
        c,
        entityType: 'desk_problem',
        action: 'updated',
        entityId: id,
        data: { ...problem, changes } as unknown as Record<string, unknown>,
      });
    }
    return success(c, problem);
  } catch (err) {
    return refusal(c, err, 'Failed to update the problem');
  }
});

app.delete('/:id', requirePermission('problems:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const { problem } = await deleteDeskProblem(c.get('tenantDb'), id);
    publishEntityEvent({
      c,
      entityType: 'desk_problem',
      action: 'deleted',
      entityId: id,
      data: problem as unknown as Record<string, unknown>,
    });
    return noContent(c);
  } catch (err) {
    return refusal(c, err, 'Failed to delete the problem');
  }
});

app.get(
  '/:id/conversations',
  requirePermission('problems:read'),
  zValidator('query', listDeskProblemConversationsQuerySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    try {
      const problem = await getDeskProblem(db, id);
      if (!problem) return error.notFound(c, 'Problem', id);
      return success(c, await listDeskProblemConversations(db, id, c.req.valid('query')));
    } catch (err) {
      return refusal(c, err, 'Failed to load the linked tickets');
    }
  },
);

/**
 * A note or a reply with the workaround on every open linked ticket. Replies
 * are delivered per channel like an incident update (messenger: the visitor's
 * room; email: sendDeskEmailReply; other channels: the timeline).
 */
app.post(
  '/:id/share-workaround',
  requirePermission('problems:update'),
  zValidator('json', shareDeskProblemWorkaroundSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { body, visibility } = c.req.valid('json');
    try {
      const result = await shareDeskProblemWorkaround(db, {
        generateId,
        authorId: c.get('userId'),
        problemId: id,
        body,
        visibility,
      });
      await publishDeskLinkChanges(c, result.changes);
      if (visibility === 'reply') {
        for (const { conversation, message } of result.changes) {
          if (conversation.channel !== 'email') continue;
          try {
            await sendDeskEmailReply(c.env, db, conversation, message, {
              clerkOrgId: c.get('clerkOrgId'),
              waitUntil: (promise) => c.executionCtx.waitUntil(promise),
            });
          } catch (err) {
            console.error('[desk-api/desk-problems] workaround email failed:', err);
          }
        }
      }
      return success(c, {
        visibility,
        delivered: result.changes.length,
        skipped: result.skipped,
        conversationIds: result.changes.map((change) => change.conversation.id),
      });
    } catch (err) {
      return refusal(c, err, 'Failed to share the workaround');
    }
  },
);

/** The most linked tickets an article records as related. */
const RELATED_TICKETS = 50;

/** A draft, internal help-center article from the problem (symptoms, cause, workaround). */
app.post('/:id/article', requirePermission('problems:read'), requirePermission('articles:create'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const problem = await getDeskProblem(db, id);
    if (!problem) return error.notFound(c, 'Problem', id);
    if (problem.articleId) {
      const [existing] = await db.select({ id: articles.id }).from(articles).where(eq(articles.id, problem.articleId)).limit(1);
      if (existing) {
        return error.conflict(c, 'This problem already has an article', { reason: 'article_exists', articleId: existing.id });
      }
    }

    const draft = deskArticleDraftFromProblem(problem);
    const incidents = await listDeskProblemConversations(db, id, { limit: RELATED_TICKETS });
    const articleId = generateId('art');
    const slug = `${deskArticleSlug(draft.title) || articleId}-${articleId.slice(4, 10)}`;
    const authorId = c.get('userId');
    const now = new Date();
    await db.insert(articles).values({
      id: articleId,
      title: draft.title,
      slug,
      content: draft.content,
      excerpt: draft.excerpt,
      status: 'draft',
      visibility: 'internal',
      audienceCompanyIds: [],
      authorId,
      isDraft: true,
      publishedAt: null,
      relatedTickets: incidents.map((incident) => incident.id),
      viewCount: 0,
      helpfulCount: 0,
      notHelpfulCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({
      c,
      entityType: 'helpdesk_article',
      entityId: articleId,
      action: 'created',
      data: { id: articleId, title: draft.title, slug, status: 'draft', authorId, problemId: id },
    });

    const updated = await setDeskProblemArticle(db, id, articleId);
    publishEntityEvent({
      c,
      entityType: 'desk_problem',
      action: 'updated',
      entityId: id,
      data: { ...updated, changes: { articleId: { from: problem.articleId, to: articleId } } } as unknown as Record<string, unknown>,
    });
    return success(c, updated, 201);
  } catch (err) {
    return refusal(c, err, 'Failed to create the article');
  }
});

export { app as deskProblemsRoutes };
