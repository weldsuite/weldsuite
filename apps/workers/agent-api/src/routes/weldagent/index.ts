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
import { requirePermission, ensurePermissionsResolved } from '@weldsuite/permissions/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  createConversationSchema,
  updateConversationSchema,
  saveMessageSchema,
  weldAgentSettingsSchema,
  autoTitleSchema,
  completeTurnSchema,
} from '@weldsuite/app-api-client/schemas/weldagent';
import { InsufficientAiCreditsError } from '@weldsuite/core-domain/ai-billing';
import {
  acceptConversationTurn,
  completeConversationTurn,
  toAcceptedTurnRef,
  AgentAccessDeniedError,
  ConversationNotFoundError,
  relativeToMessage,
} from '@weldsuite/agent-domain/complete-turn';
import { enqueueWeldAgentJob } from '@weldsuite/agent-domain/jobs';
import { findAccessibleAgentRow } from '@weldsuite/agent-domain/access';
import { agentViewer } from '../../services/weldagent/viewer';
import { personaPermissions } from '../../services/weldagent/persona-permissions';
import {
  AllGatewaysFailedError,
  GatewayConfigError,
  isAuthFailure,
  isGatewayConfigured,
} from '@weldsuite/ai';
import type { Env, Variables } from '../../types';
import { error, success, noContent } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { weldagentAgentsRoutes } from './agents';
import { weldagentParityRoutes } from './parity';

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
  const limit = Math.min(Number.parseInt(c.req.query('limit') || '50', 10), 100);
  const agentId = c.req.query('agentId') || undefined;
  const db = c.get('tenantDb');
  const { weldagentConversations } = schema;

  try {
    const conditions = [
      eq(weldagentConversations.userId, userId),
      isNull(weldagentConversations.deletedAt),
    ];
    // `agentId=none` → personal assistant chats only (home sidebar "Recent").
    if (agentId === 'none') {
      conditions.push(isNull(weldagentConversations.agentId));
    } else if (agentId) {
      conditions.push(eq(weldagentConversations.agentId, agentId));
    }

    const conversations = await db
      .select()
      .from(weldagentConversations)
      .where(and(...conditions))
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
      const agent = await findAccessibleAgentRow(db, data.agentId, await agentViewer(c));
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
/** GET /conversations/:conversationId — one of the current user's conversations (notification links). */
app.get('/conversations/:conversationId', async (c) => {
  const userId = c.get('userId');
  const conversationId = c.req.param('conversationId');
  const { weldagentConversations } = schema;
  try {
    const [conversation] = await c
      .get('tenantDb')
      .select()
      .from(weldagentConversations)
      .where(
        and(
          eq(weldagentConversations.id, conversationId),
          eq(weldagentConversations.userId, userId),
          isNull(weldagentConversations.deletedAt),
        ),
      )
      .limit(1);
    if (!conversation) return error.notFound(c, 'Conversation', conversationId);
    return success(c, toConversationSummary(conversation));
  } catch (err) {
    console.error('[app-api/weldagent] get conversation failed:', err);
    return error.internal(c, 'Failed to load conversation');
  }
});

app.get('/conversations/:conversationId/messages', async (c) => {
  const userId = c.get('userId');
  const conversationId = c.req.param('conversationId');
  const limit = Math.min(Number.parseInt(c.req.query('limit') || '100', 10), 200);
  const offset = Number.parseInt(c.req.query('offset') || '0', 10);
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

    const where = and(
      eq(weldagentMessages.conversationId, conversationId),
      isNull(weldagentMessages.deletedAt),
    );

    // `before=<messageId>`: the page just older than that message (scrolling
    // back through a long continuous chat), in chronological order.
    const before = c.req.query('before');
    if (before) {
      const [anchor] = await db
        .select({ id: weldagentMessages.id })
        .from(weldagentMessages)
        .where(and(eq(weldagentMessages.id, before), eq(weldagentMessages.conversationId, conversationId)))
        .limit(1);
      if (!anchor) return success(c, []);
      const older = await db
        .select()
        .from(weldagentMessages)
        .where(and(where, relativeToMessage('<', anchor.id)))
        .orderBy(desc(weldagentMessages.createdAt), desc(weldagentMessages.id))
        .limit(limit);
      return success(c, older.reverse());
    }

    // With an explicit offset: legacy oldest-first paging. Without one: the
    // latest `limit` messages, still in chronological order — chat UIs need
    // the tail of a long thread, not its first page.
    if (c.req.query('offset') !== undefined) {
      const page = await db
        .select()
        .from(weldagentMessages)
        .where(where)
        .orderBy(weldagentMessages.createdAt, weldagentMessages.id)
        .limit(limit)
        .offset(offset);
      return success(c, page);
    }

    const latest = await db
      .select()
      .from(weldagentMessages)
      .where(where)
      .orderBy(desc(weldagentMessages.createdAt), desc(weldagentMessages.id))
      .limit(limit);

    return success(c, latest.reverse());
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
 * Server-owned chat turn. By default persists the user message and returns
 * immediately (`status: accepted`); the assistant reply is generated in the
 * Worker via `waitUntil`. Pass `{ wait: true }` to block until the reply is
 * persisted (tests / callers that need the full turn in one response).
 */
/** The client's IANA timezone, or null when it is missing or unknown to the runtime. */
function validTimezone(value: string | undefined): string | null {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** Turn failures the response already reports (no log noise from the waitUntil copy). */
function isExpectedTurnError(err: unknown): boolean {
  return (
    err instanceof ConversationNotFoundError ||
    err instanceof AgentAccessDeniedError ||
    err instanceof InsufficientAiCreditsError
  );
}

/** The response for a missing conversation or an agent the caller lost access to. */
function expectedTurnErrorResponse(
  c: Parameters<typeof error.notFound>[0],
  err: unknown,
  conversationId: string,
): Response | null {
  if (err instanceof ConversationNotFoundError) return error.notFound(c, 'Conversation', conversationId);
  if (err instanceof AgentAccessDeniedError) return error.forbidden(c, 'You no longer have access to this agent');
  return null;
}

app.post(
  '/conversations/:conversationId/complete-turn',
  requirePermission('agents:read', 'weldagent:use'),
  zValidator('json', completeTurnSchema),
  async (c) => {
    const conversationId = c.req.param('conversationId');
    const { content, agentId, wait } = c.req.valid('json');
    const timezone = validTimezone(c.req.valid('json').timezone);
    const db = c.get('tenantDb');
    const env = c.env;
    // Carried into the WeldAgent job params and tool context, which hold the Clerk org id.
    const clerkOrgId = c.get('clerkOrgId');
    const userId = c.get('userId');
    // The agent acts on the user's behalf: its grants are narrowed to theirs.
    const actorPermissions = (await ensurePermissionsResolved(c))?.permissions ?? [];
    // Without an agent, the default WeldAgent reads for them: checked deny-aware here.
    const personaKeys = await personaPermissions(c);
    // An agent's chat stays usable only while its owner keeps you on it.
    const viewer = await agentViewer(c);

    try {
      if (wait) {
        const work = completeConversationTurn({
          db,
          env,
          workspaceId: clerkOrgId,
          userId,
          conversationId,
          content,
          agentId,
          actorPermissions,
          personaPermissions: personaKeys,
          timezone,
          viewer,
        });

        c.executionCtx.waitUntil(
          work.catch((err) => {
            if (isExpectedTurnError(err)) return;
            console.error('[app-api/weldagent] complete-turn waitUntil failed:', err);
          }),
        );

        const result = await work;
        return success(c, result);
      }

      const accepted = await acceptConversationTurn({
        db,
        env,
        workspaceId: clerkOrgId,
        userId,
        conversationId,
        content,
        agentId,
        actorPermissions,
        personaPermissions: personaKeys,
        timezone,
        viewer,
      });

      // Generate the reply in the durable WeldAgent job workflow — a tool loop
      // routinely outlives the ~30s waitUntil budget after this response.
      await enqueueWeldAgentJob(
        env,
        (p) => c.executionCtx.waitUntil(p),
        { kind: 'chat-turn', ...toAcceptedTurnRef(accepted) },
        db,
      );

      return success(c, {
        status: 'accepted' as const,
        pending: true,
        userMessage: accepted.userMessage,
        assistantMessage: null,
      });
    } catch (err) {
      const expected = expectedTurnErrorResponse(c, err, conversationId);
      if (expected) return expected;
      if (err instanceof InsufficientAiCreditsError) {
        return error.insufficientCredits(c, {
          currentBalance: err.currentBalance,
          required: err.required,
          shortfall: err.shortfall,
        });
      }
      // Surface AI Gateway misconfig clearly — otherwise ops only see a bare 500
      // in Workers Observability while the real cause is in a sibling console line.
      const authCause =
        err instanceof AllGatewaysFailedError ? err.cause : err;
      if (
        err instanceof GatewayConfigError ||
        !isGatewayConfigured(c.env) ||
        isAuthFailure(err) ||
        isAuthFailure(authCause)
      ) {
        console.error('[app-api/weldagent] complete-turn AI gateway auth/config failed:', err);
        return error.badGateway(
          c,
          'AI gateway rejected the request. On weldsuite-app-api-test set secret AI_GATEWAY_API_TOKEN (Workers AI + AI Gateway Run scopes) for account CF_ACCOUNT_ID.',
        );
      }
      if (err instanceof AllGatewaysFailedError) {
        console.error('[app-api/weldagent] complete-turn AI gateway upstream failed:', err);
        return error.badGateway(c, err.message);
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

      let title = firstUserMessage.replaceAll(/\s+/g, ' ').trim().slice(0, 60) || 'New Chat';
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

app.route('/', weldagentParityRoutes);
app.route('/agents', weldagentAgentsRoutes);

export const weldagentRoutes = app;
