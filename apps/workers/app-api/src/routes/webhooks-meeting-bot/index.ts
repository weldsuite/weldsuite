/**
 * MeetingBaas Webhook — PUBLIC route.
 *
 * POST /api/webhooks/meeting-bot
 * GET  /api/webhooks/meeting-bot (health check)
 *
 * Ported from apps/api-worker/src/routes/webhooks/meeting-bot.ts
 * (legacy worker phase-out, W3). Mounted BEFORE clerkMiddleware —
 * MeetingBaas posts server-to-server without Clerk tokens. Session/workspace
 * resolution happens from the payload's `extra` metadata (with a bounded
 * all-workspace fallback scan), exactly as api-worker did.
 *
 * Response shapes are the LEGACY shapes (`{ received: true }` /
 * `{ error: string }`) that MeetingBaas expects — intentionally NOT the
 * app-api `{ data }` envelope.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import {
  handleStatusChange,
  handleComplete,
  handleFailed,
  type MeetingBaasWebhookPayload,
} from '../../services/meeting-bot-webhook';
import { verifyWebhookToken } from '../../lib/webhook-token';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST / - Handle MeetingBaas webhooks
 */
app.post('/', async (c) => {
  // Reject forged calls: the URL registered with MeetingBaas carries a shared
  // `?token=`. No-op until MEETINGBAAS_WEBHOOK_TOKEN is set (and the token is
  // appended to the URL configured in MeetingBaas).
  if (!verifyWebhookToken(c, c.env.MEETINGBAAS_WEBHOOK_TOKEN)) {
    console.warn('[MeetingBaas Webhook] Rejected: missing/invalid token');
    return c.json({ error: 'unauthorized' }, 401);
  }

  let payload: MeetingBaasWebhookPayload;

  try {
    payload = await c.req.json();
  } catch {
    console.error('[MeetingBaas Webhook] Invalid JSON payload');
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Normalize: MeetingBaas nests most fields inside `data`, including `extra`
  const extra = payload.extra || payload.data?.extra;
  const botId = payload.data?.bot_id || payload.bot_id;
  const statusCode = payload.data?.status?.code || payload.status?.code || '';
  const statusMessage = payload.data?.status?.message || payload.status?.message || '';

  // Hoist extra to top level so all handlers can access it uniformly
  if (!payload.extra && extra) {
    payload.extra = extra;
  }

  console.log(`[MeetingBaas Webhook] Received event: ${payload.event}`, {
    botId,
    statusCode,
    platformSessionId: extra?.platformSessionId,
    workspaceId: extra?.workspaceId,
  });

  // Create normalized payload for handlers
  const normalizedPayload = {
    ...payload,
    _botId: botId,
    _statusCode: statusCode,
    _statusMessage: statusMessage,
  };

  try {
    switch (payload.event) {
      case 'bot.status_change':
        await handleStatusChange(c.env, normalizedPayload);
        break;

      case 'complete':
      case 'bot.completed':
        await handleComplete(c.env, normalizedPayload);
        break;

      case 'failed':
      case 'bot.failed':
        await handleFailed(c.env, normalizedPayload);
        break;

      default:
        console.log(`[MeetingBaas Webhook] Unhandled event: ${payload.event}`);
    }

    return c.json({ received: true });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MeetingBaas Webhook] Error processing event:', error);
    return c.json({ error: errorMessage }, 500);
  }
});

/**
 * GET / - Health check
 */
app.get('/', (c) => {
  return c.json({ status: 'ok', service: 'meeting-bot-webhook' });
});

export const webhooksMeetingBotRoutes = app;
