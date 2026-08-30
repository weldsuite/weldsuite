/**
 * WeldAgent routes — /api/weldagent/* surface.
 *
 * The personal AI assistant's data layer: conversations + messages (per-user
 * chat history that backs the home sidebar's "Recent chats" list and the
 * full-page chat at /new-chat).
 *
 * All rows are scoped by the Clerk `userId` (WeldAgent threads are private to
 * the user, like user-preferences / push-tokens), so these routes follow the
 * same no-`requirePermission` pattern — auth + tenant DB + userId filtering is
 * the guard.
 *
 * The interactive AI chat stream lives at /api/ai/chat/stream (the `@weldsuite/ai`
 * gateway); this router only persists the resulting turns. Settings and
 * @-mention search return safe defaults — they were part of the pre-teardown
 * surface and are kept as no-ops so the client contract stays intact.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  createConversationSchema,
  updateConversationSchema,
  saveMessageSchema,
  weldAgentSettingsSchema,
  autoTitleSchema,
  completeTurnSchema,
} from '@weldsuite/app-api-client/schemas/weldagent';
import { InsufficientAiCreditsError } from '../../services/ai/billing';
import {
  completeConversationTurn,
  ConversationNotFoundError,
} from '../../services/weldagent/complete-turn';
import { getAgent } from '../../services/weldagent/agents';
import type { Env, Variables } from '../../types';
import { error, success, noContent } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { weldagentAgentsRoutes } from './agents';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function toConversationSummary(conv: {
  id: string;
  name: string;
  moduleKey: string | null;
  agentId: string | null;
  isPinned: boolean;
  lastMessageAt: Date | null;
  messageCount: number;
  createdAt: Date;
}) {
  return {
    id: conv.id,
    name: conv.name,
    moduleKey: conv.moduleKey,
    agentId: conv.agentId,
    isPinned: conv.isPinned,
    lastMessageAt: conv.lastMessageAt,
    messageCount: conv.messageCount,
    createdAt: conv.createdAt,
  };
}

// ============================================================================
// Conversations
// ============================================================================

/** GET /conversations — list the current user's conversations. */
app.get('/conversations', async (c) => {
  const userId = c.get('userId');
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const db = c.get('tenantDb');
  const { weldagentConversations } = schema;

  try {
    const conversations = await db
      .select()
      .from(weldagentConversations)
      .where(
        and(eq(weldagentConversations.userId, userId), isNull(weldagentConversations.deletedAt)),
      )
      .orderBy(
        desc(weldagentConversations.isPinned),
        // Fall back to createdAt when a conversation has no messages yet, so
        // never-used placeholders can't outrank freshly-used chats. (In
        // Postgres a bare `DESC` sorts NULLs first.)
        desc(sql`COALESCE(${weldagentConversations.lastMessageAt}, ${weldagentConversations.createdAt})`),
      )
      .limit(limit);

    return success(
      c,
      conversations.map((conv) => toConversationSummary(conv)),
    );
  } catch (err) {
    console.error('[app-api/weldagent] list conversations failed:', err);
    return error.internal(c, 'Failed to list conversations');
  }
});

/** POST /conversations — create a conversation. */
app.post('/conversations', zValidator('json', createConversationSchema), async (c) => {
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const db = c.get('tenantDb');
  const { weldagentConversations } = schema;

  try {
    if (data.agentId) {
      const agent = await getAgent(db, data.agentId);
      if (!agent) return error.notFound(c, 'Agent', data.agentId);
    }

    const id = generateId('conv');
    await db.insert(weldagentConversations).values({
      id,
      userId,
      name: data.name || 'New Conversation',
      moduleKey: data.moduleKey || null,
      agentId: data.agentId || null,
      isPinned: false,
      messageCount: 0,
      // Seed lastMessageAt so a brand-new conversation sorts by recency from
      // the moment it's created.
      lastMessageAt: new Date(),
    });

    const [conversation] = await db
      .select()
      .from(weldagentConversations)
      .where(eq(weldagentConversations.id, id))
      .limit(1);

    return success(c, toConversationSummary(conversation), 201);
  } catch (err) {
    console.error('[app-api/weldagent] create conversation failed:', err);
    return error.internal(c, 'Failed to create conversation');
  }
});

/** GET /conversations/:conversationId/messages — list messages in a thread. */
app.get('/conversations/:conversationId/messages', async (c) => {
  const userId = c.get('userId');
  const conversationId = c.req.param('conversationId');
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 200);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const db = c.get('tenantDb');
  const { weldagentConversations, weldagentMessages } = schema;

  try {
    const [conversation] = await db
      .select()
      .from(weldagentConversations)
      .where(
        and(
          eq(weldagentConversations.id, conversationId),
          eq(weldagentConversations.userId, userId),
        ),
      )
      .limit(1);

    if (!conversation) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    const messages = await db
      .select()
      .from(weldagentMessages)
      .where(
        and(
          eq(weldagentMessages.conversationId, conversationId),
          isNull(weldagentMessages.deletedAt),
        ),
      )
      .orderBy(weldagentMessages.createdAt)
      .limit(limit)
      .offset(offset);

    return success(c, messages);
  } catch (err) {
    console.error('[app-api/weldagent] list messages failed:', err);
    return error.internal(c, 'Failed to get messages');
  }
});

/** POST /conversations/:conversationId/messages — append a message. */
app.post(
  '/conversations/:conversationId/messages',
  zValidator('json', saveMessageSchema),
  async (c) => {
    const userId = c.get('userId');
    const conversationId = c.req.param('conversationId');
    const data = c.req.valid('json');
    const db = c.get('tenantDb');
    const { weldagentConversations, weldagentMessages } = schema;

    try {
      const [conversation] = await db
        .select()
        .from(weldagentConversations)
        .where(
          and(
            eq(weldagentConversations.id, conversationId),
            eq(weldagentConversations.userId, userId),
          ),
        )
        .limit(1);

      if (!conversation) {
        return error.notFound(c, 'Conversation', conversationId);
      }

      const messageId = generateId('msg');
      await db.insert(weldagentMessages).values({
        id: messageId,
        conversationId,
        role: data.role,
        content: data.content,
        toolInvocations: data.toolInvocations || null,
        formState: data.formState || null,
      });

      await db
        .update(weldagentConversations)
        .set({
          lastMessageAt: new Date(),
          messageCount: conversation.messageCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(weldagentConversations.id, conversationId));

      const [savedMessage] = await db
        .select()
        .from(weldagentMessages)
        .where(eq(weldagentMessages.id, messageId))
        .limit(1);

      return success(c, savedMessage, 201);
    } catch (err) {
      console.error('[app-api/weldagent] save message failed:', err);
      return error.internal(c, 'Failed to save message');
    }
  },
);

/**
 * POST /conversations/:conversationId/complete-turn
 *
 * Server-owned chat turn: persist the user message, generate a reply, persist
 * the assistant message, notify the owner. Wrapped in waitUntil so a
 * backgrounded mobile client still gets a completed turn + push.
 */
app.post(
  '/conversations/:conversationId/complete-turn',
  requirePermission('agents:read', 'weldagent:use'),
  zValidator('json', completeTurnSchema),
  async (c) => {
    const conversationId = c.req.param('conversationId');
    const { content, agentId } = c.req.valid('json');

    const work = completeConversationTurn({
      db: c.get('tenantDb'),
      env: c.env,
      workspaceId: c.get('workspaceId'),
      userId: c.get('userId'),
      conversationId,
      content,
      agentId,
    });

    c.executionCtx.waitUntil(
      work.catch((err) => {
        console.error('[app-api/weldagent] complete-turn waitUntil failed:', err);
      }),
    );

    try {
      const result = await work;
      return success(c, result);
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        return error.notFound(c, 'Conversation', conversationId);
      }
      if (err instanceof InsufficientAiCreditsError) {
        return error.insufficientCredits(c, {
          currentBalance: err.currentBalance,
          required: err.required,
          shortfall: err.shortfall,
        });
      }
      console.error('[app-api/weldagent] complete-turn failed:', err);
      return error.internal(c, err instanceof Error ? err.message : 'Failed to complete turn');
    }
  },
);

/** PATCH /conversations/:conversationId — rename / pin. */
app.patch(
  '/conversations/:conversationId',
  zValidator('json', updateConversationSchema),
  async (c) => {
    const userId = c.get('userId');
    const conversationId = c.req.param('conversationId');
    const data = c.req.valid('json');
    const db = c.get('tenantDb');
    const { weldagentConversations } = schema;

    try {
      const updateFields: Partial<typeof weldagentConversations.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (data.name !== undefined) updateFields.name = data.name;
      if (data.isPinned !== undefined) updateFields.isPinned = data.isPinned;

      await db
        .update(weldagentConversations)
        .set(updateFields)
        .where(
          and(
            eq(weldagentConversations.id, conversationId),
            eq(weldagentConversations.userId, userId),
          ),
        );

      const [updated] = await db
        .select()
        .from(weldagentConversations)
        .where(
          and(
            eq(weldagentConversations.id, conversationId),
            eq(weldagentConversations.userId, userId),
          ),
        )
        .limit(1);

      if (!updated) {
        return error.notFound(c, 'Conversation', conversationId);
      }

      return success(c, toConversationSummary(updated));
    } catch (err) {
      console.error('[app-api/weldagent] update conversation failed:', err);
      return error.internal(c, 'Failed to update conversation');
    }
  },
);

/**
 * POST /conversations/:conversationId/auto-title
 *
 * Derives a short title from the first user message and persists it. Idempotent
 * — only runs while the conversation still has its placeholder name, so a
 * user-chosen name is never clobbered. (Text-model title generation was removed
 * in the AI teardown; a trimmed first message is a good-enough label and keeps
 * this route dependency-free.)
 */
app.post(
  '/conversations/:conversationId/auto-title',
  zValidator('json', autoTitleSchema),
  async (c) => {
    const userId = c.get('userId');
    const conversationId = c.req.param('conversationId');
    const { firstUserMessage } = c.req.valid('json');
    const db = c.get('tenantDb');
    const { weldagentConversations } = schema;

    try {
      const [existing] = await db
        .select()
        .from(weldagentConversations)
        .where(
          and(
            eq(weldagentConversations.id, conversationId),
            eq(weldagentConversations.userId, userId),
          ),
        )
        .limit(1);

      if (!existing) {
        return error.notFound(c, 'Conversation', conversationId);
      }

      const placeholder =
        !existing.name ||
        existing.name === 'New Chat' ||
        existing.name === 'New Conversation';
      if (!placeholder) {
        return success(c, { id: existing.id, name: existing.name, generated: false });
      }

      let title = firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New Chat';
      if (title.length > 80) title = title.slice(0, 80).trim();

      await db
        .update(weldagentConversations)
        .set({ name: title, updatedAt: new Date() })
        .where(
          and(
            eq(weldagentConversations.id, conversationId),
            eq(weldagentConversations.userId, userId),
          ),
        );

      return success(c, { id: conversationId, name: title, generated: true });
    } catch (err) {
      console.error('[app-api/weldagent] auto-title failed:', err);
      return error.internal(c, 'Failed to auto-title conversation');
    }
  },
);

/** DELETE /conversations/:conversationId — soft delete. */
app.delete('/conversations/:conversationId', async (c) => {
  const userId = c.get('userId');
  const conversationId = c.req.param('conversationId');
  const db = c.get('tenantDb');
  const { weldagentConversations } = schema;

  try {
    const [existing] = await db
      .select()
      .from(weldagentConversations)
      .where(
        and(
          eq(weldagentConversations.id, conversationId),
          eq(weldagentConversations.userId, userId),
        ),
      )
      .limit(1);

    if (!existing) {
      return error.notFound(c, 'Conversation', conversationId);
    }

    await db
      .update(weldagentConversations)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(weldagentConversations.id, conversationId));

    return noContent(c);
  } catch (err) {
    console.error('[app-api/weldagent] delete conversation failed:', err);
    return error.internal(c, 'Failed to delete conversation');
  }
});

// ============================================================================
// Settings — no persisted table post-teardown; return/echo safe defaults so
// the client contract stays intact.
// ============================================================================

const DEFAULT_SETTINGS = {
  preferredModel: 'openai/gpt-4o',
  fallbackModel: 'anthropic/claude-sonnet-4-20250514',
  temperature: 0.7,
  maxTokens: 4096,
  showToolCalls: true,
  autoSendSuggestions: false,
  saveConversationHistory: true,
  customInstructions: '',
  appPermissions: {
    crm: true,
    accounting: true,
    wms: true,
    mail: true,
    helpdesk: true,
    parcel: true,
    projects: true,
    tasks: true,
    host: true,
  },
};

/** GET /settings — per-user WeldAgent settings (defaults). */
app.get('/settings', (c) => {
  const userId = c.get('userId');
  return success(c, { id: '', userId, ...DEFAULT_SETTINGS });
});

/** PUT /settings — echo merged settings (not persisted). */
app.put('/settings', zValidator('json', weldAgentSettingsSchema), (c) => {
  const userId = c.get('userId');
  const data = c.req.valid('json');
  return success(c, { id: '', userId, ...DEFAULT_SETTINGS, ...data });
});

// ============================================================================
// Mentions search — no-op post-teardown (kept for client contract).
// ============================================================================

/** GET /mentions/search — returns no results (mention search is disabled). */
app.get('/mentions/search', (c) => success(c, []));

app.route('/agents', weldagentAgentsRoutes);

export const weldagentRoutes = app;
