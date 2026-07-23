/**
 * WeldChat Clips — /api/chat-clips/*.
 *
 * Clip transcription triggering + transcript callback updates. Ported from
 * api-worker `src/routes/chat/clips.ts` (W3 legacy-worker phase-out), where
 * it was mounted at `/api/chat/channels/:channelId/clips`. Here the channel
 * id is the first path segment:
 *
 *   POST  /:channelId                          — mark a clip attachment as
 *         transcribing (legacy: POST /api/chat/channels/:cid/clips)
 *   PATCH /:channelId/:messageId/transcript    — write transcript results
 *         (legacy: PATCH /api/chat/channels/:cid/clips/:messageId/transcript)
 *
 * NOTE — transcription dispatch: the legacy route queued a
 * `clip-transcription` job on a `c.env.ANALYTICS_QUEUE` binding that was
 * never declared in api-worker's Env/wrangler, and the consumer was a
 * Trigger.dev task that has since been removed (see memory:
 * trigger-dev-removal). The queue send has therefore been a silent no-op for
 * a while. The port keeps the status flip + callback surface working and
 * logs a warning instead of queuing; wire a real transcription dispatcher
 * (agent-worker / workflow) in a follow-up.
 *
 * Access: requirePermission('messages:create'|'messages:update') like the
 * original, plus the canAccessChannel() membership gate that the WeldChat
 * backend security audit standardised across app-api chat endpoints.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { ChatClipAttachment } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { schema } from '../../db';
import { success, error } from '../../lib/response';
import { canAccessChannel } from '../../services/chat/channel-access';
import { publishChatClipTranscriptUpdated } from '../../services/realtime/weldchat-publisher';

// ============================================================================
// Schemas (Zod v3)
// ============================================================================

const transcribeSchema = z.object({
  messageId: z.string(),
  attachmentId: z.string(),
});

const transcriptUpdateSchema = z.object({
  attachmentId: z.string(),
  transcript: z.object({
    status: z.enum(['pending', 'processing', 'completed', 'failed']),
    fullText: z.string().optional(),
    segments: z.array(z.object({
      text: z.string(),
      startTime: z.number(),
      endTime: z.number(),
      timestamp: z.string(),
    })).optional(),
    errorMessage: z.string().optional(),
  }),
});

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { chatMessages } = schema;

/**
 * POST /:channelId — Trigger transcription for a clip attachment.
 */
app.post('/:channelId', requirePermission('messages:create'), zValidator('json', transcribeSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.param('channelId');
  const { messageId, attachmentId } = c.req.valid('json');

  try {
    if (!(await canAccessChannel(db, channelId, userId))) {
      return error.forbidden(c, 'You do not have access to this channel');
    }

    // Fetch the message
    const [message] = await db
      .select({ attachments: chatMessages.attachments })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.channelId, channelId),
          isNull(chatMessages.deletedAt),
        ),
      )
      .limit(1);

    if (!message) {
      return error.notFound(c, 'Message', messageId);
    }

    const attachments = message.attachments ?? [];
    const clipIndex = attachments.findIndex(
      (att) => att.id === attachmentId && 'clipType' in att,
    );

    if (clipIndex === -1) {
      return error.notFound(c, 'Clip attachment', attachmentId);
    }

    // Update transcript status to processing
    const clip = attachments[clipIndex] as ChatClipAttachment;
    clip.transcript = { status: 'processing' };
    attachments[clipIndex] = clip;

    await db
      .update(chatMessages)
      .set({ attachments, updatedAt: new Date() })
      .where(eq(chatMessages.id, messageId));

    // Transcription dispatch pending rebuild — the legacy Trigger.dev
    // pipeline is gone and its queue binding never existed (see header).
    console.warn('[app-api/chat-clips] Transcription requested but no dispatcher is wired; clip stays in processing until the transcript callback fires.', { messageId, attachmentId });

    publishEntityEvent({
      c,
      entityType: 'chat_message',
      entityId: messageId,
      action: 'updated',
      data: { id: messageId, channelId },
    });

    return success(c, { messageId, attachmentId, status: 'processing' });
  } catch (err) {
    console.error('[app-api/chat-clips] Failed to trigger transcription:', err);
    return error.internal(c, 'Failed to trigger transcription');
  }
});

/**
 * PATCH /:channelId/:messageId/transcript — Update clip transcript
 * (callback surface for the transcription pipeline).
 */
app.patch('/:channelId/:messageId/transcript', requirePermission('messages:update'), zValidator('json', transcriptUpdateSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const channelId = c.req.param('channelId');
  const messageId = c.req.param('messageId');
  const { attachmentId, transcript } = c.req.valid('json');

  try {
    if (!(await canAccessChannel(db, channelId, userId))) {
      return error.forbidden(c, 'You do not have access to this channel');
    }

    // Fetch the message
    const [message] = await db
      .select({ attachments: chatMessages.attachments })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.channelId, channelId),
          isNull(chatMessages.deletedAt),
        ),
      )
      .limit(1);

    if (!message) {
      return error.notFound(c, 'Message', messageId);
    }

    const attachments = message.attachments ?? [];
    const clipIndex = attachments.findIndex(
      (att) => att.id === attachmentId && 'clipType' in att,
    );

    if (clipIndex === -1) {
      return error.notFound(c, 'Clip attachment', attachmentId);
    }

    // Update the transcript in the attachment
    const clip = attachments[clipIndex] as ChatClipAttachment;
    clip.transcript = transcript;
    attachments[clipIndex] = clip;

    await db
      .update(chatMessages)
      .set({ attachments, updatedAt: new Date() })
      .where(eq(chatMessages.id, messageId));

    // Publish real-time event
    try {
      await publishChatClipTranscriptUpdated(c.env, channelId, {
        messageId,
        attachmentId,
        transcript,
      });
    } catch (e) {
      console.error('[app-api/chat-clips] realtime publish failed:', e);
    }

    publishEntityEvent({
      c,
      entityType: 'chat_message',
      entityId: messageId,
      action: 'updated',
      data: { id: messageId, channelId },
    });

    return success(c, { messageId, attachmentId, transcript });
  } catch (err) {
    console.error('[app-api/chat-clips] Failed to update transcript:', err);
    return error.internal(c, 'Failed to update transcript');
  }
});

export const chatClipsRoutes = app;
