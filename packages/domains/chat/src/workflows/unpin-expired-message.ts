/**
 * UnpinExpiredMessageWorkflow — Cloudflare Workflow
 *
 * Sleeps until the pin expiry time, then automatically unpins the message.
 * Uses messageId as the workflow instance ID so manual unpin can cancel it.
 *
 * Ported from apps/api-worker/src/workflows/unpin-expired-message.ts (W4
 * legacy-worker phase-out). Hosted in chat-api under the workflow names
 * `unpin-expired-message-v3[-dev]` (bound as UNPIN_EXPIRED_MESSAGE and
 * re-exported from chat-api's src/index.ts), dispatched from its
 * routes/chat-messages pin endpoints (mirrors api-worker routes/chat/messages.ts).
 * app-api keeps its old `unpin-expired-message-v2*` names and re-exports this
 * class only while their in-flight instances drain
 * (docs/plans/app-api-module-split.md, "Workflows draining in app-api").
 */

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import type { DbEnv } from '@weldsuite/worker-kit/env';
import { getTenantDbForWorkspace, schema } from '@weldsuite/worker-kit/db';
import {
  publishChatMessageUnpinned,
  type WeldChatPublisherEnv,
} from '../realtime/weldchat-publisher';

/**
 * The bindings the workflow reads: tenant DB resolution and the realtime
 * fan-out. Any worker Env with them fits.
 */
export type UnpinExpiredMessageEnv = DbEnv & WeldChatPublisherEnv;

export interface UnpinExpiredMessageParams {
  workspaceId: string;
  channelId: string;
  messageId: string;
  expiresAt: string; // ISO string
}

export class UnpinExpiredMessageWorkflow extends WorkflowEntrypoint<UnpinExpiredMessageEnv, UnpinExpiredMessageParams> {
  async run(event: WorkflowEvent<UnpinExpiredMessageParams>, step: WorkflowStep) {
    const { workspaceId, channelId, messageId, expiresAt } = event.payload;

    // Sleep until the pin expiry time
    await step.sleepUntil('wait-until-expiry', new Date(expiresAt));

    // Unpin with retries — guard prevents double-unpin
    await step.do('unpin-message', {
      retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
    }, async () => {
      const db = await getTenantDbForWorkspace(this.env, workspaceId);
      const { chatMessages } = schema;

      const [message] = await db
        .select({ isPinned: chatMessages.isPinned })
        .from(chatMessages)
        .where(eq(chatMessages.id, messageId))
        .limit(1);

      if (!message) {
        console.log(`[UnpinExpired] Message ${messageId} not found, skipping`);
        return;
      }

      // Guard: only unpin if still pinned
      if (!message.isPinned) {
        console.log(`[UnpinExpired] Message ${messageId} already unpinned, skipping`);
        return;
      }

      await db.update(chatMessages).set({
        isPinned: false,
        pinnedAt: null,
        pinnedBy: null,
        pinExpiresAt: null,
        updatedAt: new Date(),
      }).where(eq(chatMessages.id, messageId));

      // Notify connected clients
      await publishChatMessageUnpinned(this.env, channelId, messageId);

      console.log(`[UnpinExpired] Auto-unpinned message ${messageId} in channel ${channelId}`);
    });
  }
}
