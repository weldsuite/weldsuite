/**
 * WeldDesk inbox translation — mounted on /api/desk/conversations:
 *
 *   POST /:id/translate        { messageIds?, targetLocale }
 *        → { language, targetLocale, translations: [{ messageId, text }] }
 *   POST /:id/translate-reply  { text, targetLocale? }
 *        → { text, sourceLocale, targetLocale }
 *
 * Both need `conversations:update` (the agent is working the conversation;
 * translating spends the workspace's AI credits). 402 when the wallet is
 * empty, 503 `ai_unavailable` when the AI gateway isn't configured. The
 * Kubernetes editions serve the same routes on `weldsuite-ai` (feature
 * `desk-translate`, ADR AI-012); translation.integration.test.ts runs on both.
 *
 * Sending the translated reply goes through `POST /:id/reply` with the
 * agent's own words in `translation` (internal message metadata).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  translateDeskConversationSchema,
  translateDeskReplySchema,
} from '@weldsuite/core-api-client/schemas/desk-translation';
import { InsufficientAiCreditsError, resolveAiMetering } from '@weldsuite/core-domain/ai-billing';
import { error, success } from '@weldsuite/worker-kit/response';
import * as schema from '@weldsuite/db/schema';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import {
  DeskTranslationError,
  translateConversation,
  translateReply,
} from '../../services/desk-translation';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function metering(c: AppContext) {
  return () => resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));
}

function refuse(c: AppContext, err: unknown) {
  if (err instanceof InsufficientAiCreditsError) {
    return error.insufficientCredits(c, {
      currentBalance: err.currentBalance,
      required: err.required,
      shortfall: err.shortfall,
    });
  }
  if (err instanceof DeskTranslationError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  console.error('[desk-api/desk-conversations] translation failed:', err);
  return error.internal(c, 'Failed to translate');
}

app.post(
  '/:id/translate',
  requirePermission('conversations:update'),
  zValidator('json', translateDeskConversationSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const { messageIds, targetLocale } = c.req.valid('json');
    try {
      const { languageChange, ...result } = await translateConversation({
        env: c.env,
        db,
        workspaceId: c.get('workspaceId'),
        conversationId: id,
        messageIds,
        targetLocale,
        metering: metering(c),
      });
      if (languageChange) {
        const [conversation] = await db
          .select()
          .from(schema.deskConversations)
          .where(eq(schema.deskConversations.id, id))
          .limit(1);
        if (conversation) {
          publishEntityEvent({
            c,
            entityType: 'desk_conversation',
            action: 'updated',
            entityId: id,
            data: conversation as unknown as Record<string, unknown>,
            changes: { language: languageChange },
          });
        }
      }
      return success(c, result);
    } catch (err) {
      return refuse(c, err);
    }
  },
);

app.post(
  '/:id/translate-reply',
  requirePermission('conversations:update'),
  zValidator('json', translateDeskReplySchema),
  async (c) => {
    const { text, targetLocale } = c.req.valid('json');
    try {
      const result = await translateReply({
        env: c.env,
        db: c.get('tenantDb'),
        conversationId: c.req.param('id'),
        text,
        targetLocale,
        metering: metering(c),
      });
      return success(c, result);
    } catch (err) {
      return refuse(c, err);
    }
  },
);

export { app as deskTranslationRoutes };
