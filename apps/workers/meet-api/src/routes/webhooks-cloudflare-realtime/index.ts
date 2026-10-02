/**
 * Cloudflare RealtimeKit Webhook Receiver — PUBLIC route.
 *
 * POST /api/webhooks/cloudflare-realtime        — RTK event receiver
 * POST /api/webhooks/cloudflare-realtime/setup  — one-time webhook registration
 *
 * Ported from apps/api-worker/src/routes/webhooks/cloudflare-realtime.ts
 * (legacy worker phase-out, W3). Mounted BEFORE clerkMiddleware — Cloudflare
 * RTK posts server-to-server without Clerk tokens.
 *
 * SECURITY: every delivery must carry a valid `rtk-signature` (RSA-SHA256 over
 * the raw body, verified against RealtimeKit's published public key), else
 * 401. Duplicate deliveries are dropped on their `rtk-uuid`. See
 * @weldsuite/cloudflare-realtime/webhook-signature.
 *
 * Handles meeting.ended and meeting.participantLeft events from Cloudflare
 * RealtimeKit. When RTK detects all participants have left, it auto-ends the
 * session and fires meeting.ended — we sync that to our DB.
 *
 * KV mapping (written when RTK meetings are created):
 *   Key: rtk-meeting:{cfMeetingId}
 *   Value: { orgId, type: 'session'|'call', sessionId?, meetingId?, callId?, channelId? }
 *
 * Response shape is the LEGACY `{ ok: true }` RTK expects (200 once the event
 * is accepted, so it is not retried) — intentionally NOT the `{ data }`
 * envelope.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import {
  handleMeetingEnded,
  handleParticipantLeft,
  type RtkWebhookEvent,
  type RtkMeetingMapping,
} from '../../services/rtk-webhook';
import { timingSafeEqualStr } from '@weldsuite/worker-kit/webhook-token';
import { logSafe } from '@weldsuite/worker-kit/log-safe';
import { registerWebhook } from '@weldsuite/cloudflare-realtime';
import {
  RTK_DELIVERY_ID_HEADER,
  RTK_SIGNATURE_HEADER,
  RtkWebhookKeyUnavailableError,
  verifyRtkWebhookSignature,
} from '@weldsuite/cloudflare-realtime/webhook-signature';
import { originForPathFrom } from '@weldsuite/api-modules';

const WEBHOOK_PATH = '/api/webhooks/cloudflare-realtime';

/** Processed deliveries are remembered this long (RTK retries well within it). */
const DELIVERY_DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** `rtk-uuid` values we accept as a KV key; anything else skips de-duplication. */
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST / — Receive RTK webhook events
 */
app.post('/', async (c) => {
  // Verify the raw bytes: the signature covers the body exactly as sent.
  const rawBody = await c.req.arrayBuffer();
  let verified: boolean;
  try {
    verified = await verifyRtkWebhookSignature(rawBody, c.req.header(RTK_SIGNATURE_HEADER));
  } catch (err) {
    if (!(err instanceof RtkWebhookKeyUnavailableError)) throw err;
    // Our side could not load the key, not a forged call: 5xx so RTK retries.
    console.error('[RTK Webhook] Signature key unavailable:', err.message);
    return c.json({ error: 'signature key unavailable' }, 503);
  }
  if (!verified) {
    console.warn('[RTK Webhook] Rejected: missing/invalid rtk-signature');
    return c.json({ error: 'unauthorized' }, 401);
  }

  try {
    const event = JSON.parse(new TextDecoder().decode(rawBody)) as RtkWebhookEvent;
    const eventType = event.event;
    // Documented payloads nest the id under `meeting`; older ones sent it flat.
    const rtkMeetingId = event.meeting?.id ?? event.meetingId;

    if (!rtkMeetingId) {
      console.warn('[RTK Webhook] No meeting id in payload');
      return c.json({ ok: true });
    }

    const deliveryId = c.req.header(RTK_DELIVERY_ID_HEADER);
    const dedupeKey = deliveryId && DELIVERY_ID_PATTERN.test(deliveryId)
      ? `rtk-webhook-delivery:${deliveryId}`
      : null;
    if (dedupeKey && (await c.env.WORKSPACE_CACHE.get(dedupeKey))) {
      console.log(`[RTK Webhook] Duplicate delivery ${logSafe(deliveryId)}, skipping`);
      return c.json({ ok: true });
    }

    console.log(`[RTK Webhook] ${logSafe(eventType)} — rtkMeetingId=${logSafe(rtkMeetingId)}`);

    // Look up our KV mapping
    const raw = await c.env.WORKSPACE_CACHE.get(`rtk-meeting:${rtkMeetingId}`, 'json') as RtkMeetingMapping | null;
    if (!raw) {
      // Already cleaned up, unknown meeting, or KV expired — acknowledge
      console.log(`[RTK Webhook] No KV mapping for ${logSafe(rtkMeetingId)}, skipping`);
      return c.json({ ok: true });
    }

    switch (eventType) {
      case 'meeting.ended':
        await handleMeetingEnded(c.env, raw, rtkMeetingId);
        break;

      case 'meeting.participantLeft':
        await handleParticipantLeft(c.env, raw, event);
        break;

      default:
        // Acknowledge events we don't handle
        break;
    }

    if (dedupeKey) {
      await c.env.WORKSPACE_CACHE.put(dedupeKey, '1', { expirationTtl: DELIVERY_DEDUPE_TTL_SECONDS });
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error('[RTK Webhook] Error processing event:', err);
    // Always return 200 to avoid retries
    return c.json({ ok: true });
  }
});

/**
 * POST /setup — Register the RTK webhook (one-time setup per env).
 *
 * Operator-only: requires `Authorization: Bearer <CF_REALTIME_WEBHOOK_TOKEN>`
 * and refuses when that secret is unset. Re-running it creates a duplicate
 * webhook registration; that is harmless (meeting.ended and participantLeft
 * handling are idempotent) but noisy, so run it once per environment.
 */
app.post('/setup', async (c) => {
  const env = c.env;

  if (!env.CF_REALTIME_WEBHOOK_TOKEN) {
    console.error('[RTK Webhook Setup] Rejected: CF_REALTIME_WEBHOOK_TOKEN is not configured');
    return c.json({ error: 'unauthorized' }, 401);
  }
  const auth = c.req.header('Authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!timingSafeEqualStr(provided, env.CF_REALTIME_WEBHOOK_TOKEN)) {
    console.warn('[RTK Webhook Setup] Rejected: missing/invalid bearer token');
    return c.json({ error: 'unauthorized' }, 401);
  }

  if (!env.CF_ACCOUNT_ID || !env.CF_REALTIME_APP_ID || !env.CF_REALTIME_APP_SECRET) {
    return c.json({ error: 'Missing CF_ACCOUNT_ID, CF_REALTIME_APP_ID, or CF_REALTIME_APP_SECRET' }, 400);
  }

  // Register this worker's own host (meet-api), not app-api's: forwarding
  // is meant to go away. Preview has no custom domain, so it borrows test.
  const environment = env.ENVIRONMENT ?? 'development';
  const coreUrlMap: Record<string, string> = {
    production: 'https://app-api.weldsuite.org',
    preview: 'https://app-api-test.weldsuite.org',
    test: 'https://app-api-test.weldsuite.org',
  };
  const coreUrl = coreUrlMap[environment];
  const baseUrl = coreUrl ? originForPathFrom(coreUrl, WEBHOOK_PATH) : new URL(c.req.url).origin;
  // No secret in the URL: deliveries are authenticated by their rtk-signature.
  const webhookUrl = `${baseUrl}${WEBHOOK_PATH}`;

  let result: { id?: string };
  try {
    result = await registerWebhook(env, {
      name: `WeldSuite meeting lifecycle (${environment})`,
      url: webhookUrl,
      events: ['meeting.ended', 'meeting.participantLeft'],
      enabled: true,
    });
  } catch (err) {
    // The RealtimeKit status and error payload stay in the logs rather than
    // the response.
    console.error(
      '[RTK Webhook Setup] Failed:',
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: 'Failed to register webhook' }, 500);
  }

  console.log(`[RTK Webhook Setup] Registered webhook for ${environment}: ${webhookUrl}`);
  return c.json({ ok: true, url: webhookUrl, id: result.id });
});

export const webhooksCloudflareRealtimeRoutes = app;
