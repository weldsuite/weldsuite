/**
 * Chat agent routes — /api/chat-agent/* — STUBBED.
 *
 *  - POST /ask — ask WeldAgent a question about a chat channel.
 *
 * AI has been physically removed from WeldSuite. This used to proxy the
 * question + recent-channel-context to the agent-worker over the
 * AGENT_WORKER service binding and persist both the question and the
 * generated answer as chat messages. The binding no longer exists, so the
 * endpoint now short-circuits to a 503 before touching the DB — no
 * question/answer messages are persisted, no entity event is published.
 *
 * Permission: messages:create — sibling chat routes gate message-scoped
 * mutations on the dedicated `messages:*` object (see chat-messages,
 * chat-dm, chat-search).
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const askAgentSchema = z.object({
  question: z.string().min(1),
  channelId: z.string().min(1),
});

/**
 * POST /ask — AI is currently unavailable.
 */
app.post('/ask', requirePermission('messages:create'), zValidator('json', askAgentSchema), async (c) => {
  return c.json({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } }, 503);
});

export const chatAgentRoutes = app;
