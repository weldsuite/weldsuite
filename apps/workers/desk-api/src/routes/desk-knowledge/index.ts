/**
 * Knowledge inside the inbox, mounted next to the webchat inbox at
 * /api/desk/conversations:
 *
 *   GET  /:id/article-suggestions?q=&limit=   articles for the reply: with `q` a
 *        search, else related to the customer's latest messages. Every
 *        published article an agent may share (not internal), versions
 *        included, with its help-center URL when the help center is live.
 *   POST /:id/draft-article                   a draft article from the
 *        conversation: the customer's question and the team's public answers.
 *
 * Permissions: conversations:read and articles:read | articles:create.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { deskArticleSuggestionsQuerySchema } from '@weldsuite/app-api-client/schemas/desk-knowledge';
import {
  deskArticleDraftFrom,
  deskArticleSlug,
  deskHelpCenterBaseUrl,
  deskRelatedSearch,
  deskTypedSearch,
  suggestDeskArticles,
} from '@weldsuite/db/lib/desk-articles';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const conversations = schema.deskConversations;
const messages = schema.deskMessages;
const articles = schema.helpdeskArticles;

/** The customer's messages a suggestion reads, newest first. */
const RELATED_MESSAGES = 3;
/** Messages a draft article reads, oldest first. */
const DRAFT_MESSAGES = 200;

app.get(
  '/:id/article-suggestions',
  requirePermission('conversations:read'),
  requirePermission('articles:read'),
  zValidator('query', deskArticleSuggestionsQuerySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { q, limit } = c.req.valid('query');
    try {
      const [conversation] = await db
        .select({ id: conversations.id, title: conversations.title })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      if (!conversation) return error.notFound(c, 'Conversation', id);

      const query = q ?? '';
      let search = query ? deskTypedSearch(query) : null;
      if (!query) {
        const recent = await db
          .select({ body: messages.body })
          .from(messages)
          .where(and(eq(messages.conversationId, id), eq(messages.kind, 'message'), eq(messages.authorType, 'visitor')))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(RELATED_MESSAGES);
        search = deskRelatedSearch([...recent.map((m) => m.body ?? ''), conversation.title ?? ''].join('\n'));
      }

      const helpCenterUrl = await deskHelpCenterBaseUrl(db);
      const found = search ? await suggestDeskArticles(db, search, limit ?? 5, helpCenterUrl) : [];
      return success(c, { helpCenterUrl, query, articles: found });
    } catch (err) {
      console.error('[desk-api/desk-knowledge] suggestions failed:', err);
      return error.internal(c, 'Failed to suggest articles');
    }
  },
);

app.post(
  '/:id/draft-article',
  requirePermission('conversations:read'),
  requirePermission('articles:create'),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    try {
      const [conversation] = await db
        .select({ id: conversations.id, title: conversations.title, conversationNumber: conversations.conversationNumber })
        .from(conversations)
        .where(eq(conversations.id, id))
        .limit(1);
      if (!conversation) return error.notFound(c, 'Conversation', id);

      const timeline = await db
        .select({ kind: messages.kind, authorType: messages.authorType, body: messages.body })
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(DRAFT_MESSAGES);
      const draft = deskArticleDraftFrom(conversation, timeline);

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
        visibility: 'public',
        audienceCompanyIds: [],
        authorId,
        isDraft: true,
        publishedAt: null,
        relatedTickets: [id],
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
        data: { id: articleId, title: draft.title, slug, status: 'draft', authorId, conversationId: id },
      });
      const [row] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1);
      return success(c, row, 201);
    } catch (err) {
      console.error('[desk-api/desk-knowledge] draft article failed:', err);
      return error.internal(c, 'Failed to create the draft article');
    }
  },
);

export const deskKnowledgeRoutes = app;
