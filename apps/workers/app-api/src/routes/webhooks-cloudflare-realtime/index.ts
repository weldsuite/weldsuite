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
 * SECURITY: RTK's post-Dyte webhook signature scheme is undocumented, so the
 * receiver is guarded by a shared `?token=` (CF_REALTIME_WEBHOOK_TOKEN) that
 * POST /setup registers into the webhook URL. Enforced only when the secret is
 * set — set the secret AND re-run /setup together, or legitimate (tokenless)
 * calls will 401. See lib/webhook-token.ts.
 *
 * Handles meeting.ended and meeting.participantLeft events from Cloudflare
 * RealtimeKit. When RTK detects all participants have left, it auto-ends the
 * session and fires meeting.ended — we sync that to our DB.
 *
 * KV mapping (written when RTK meetings are created):
 *   Key: rtk-meeting:{cfMeetingId}
 *   Value: { orgId, type: 'session'|'call', sessionId?, meetingId?, callId?, channelId? }
 *
 * Response shape is the LEGACY `{ ok: true }` RTK expects (always 200 to
 * avoid retries) — intentionally NOT the app-api `{ data }` envelope.
 *
 * Delta vs api-worker: the /setup baseUrlMap now points at app-api hostnames
 * (was api-worker hostnames). After deploy, POST /setup must be re-run per
 * environment so RTK delivers to app-api (W6 ops step).
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import {
  handleMeetingEnded,
  handleParticipantLeft,
  type RtkWebhookEvent,
  type RtkMeetingMapping,
} from '../../services/rtk-webhook';
import { verifyWebhookToken } from '../../lib/webhook-token';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST / — Receive RTK webhook events
 */
app.post('/', async (c) => {
  try {
    // Reject forged calls: RTK is registered with a `?token=` only we and
    // Cloudflare know. No-op until CF_REALTIME_WEBHOOK_TOKEN is set.
    if (!verifyWebhookToken(c, c.env.CF_REALTIME_WEBHOOK_TOKEN)) {
      console.warn('[RTK Webhook] Rejected: missing/invalid token');
      return c.json({ error: 'unauthorized' }, 401);
    }

    const event = await c.req.json<RtkWebhookEvent>();
    const eventType = event.event;
    const rtkMeetingId = event.meetingId;

    if (!rtkMeetingId) {
      console.warn('[RTK Webhook] No meetingId in payload');
      return c.json({ ok: true });
    }

    console.log(`[RTK Webhook] ${eventType} — rtkMeetingId=${rtkMeetingId}`);

    // Look up our KV mapping
    const raw = await c.env.WORKSPACE_CACHE.get(`rtk-meeting:${rtkMeetingId}`, 'json') as RtkMeetingMapping | null;
    if (!raw) {
      // Already cleaned up, unknown meeting, or KV expired — acknowledge
      console.log(`[RTK Webhook] No KV mapping for ${rtkMeetingId}, skipping`);
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
 * NOTE (pre-existing from api-worker): this endpoint is itself
 * unauthenticated. It only registers the well-known receiver URL with
 * Cloudflare using server-side secrets, but re-running it creates duplicate
 * webhook registrations — flagged for hardening in the migration report.
 */
app.post('/setup', async (c) => {
  const env = c.env;

  if (!env.CF_ACCOUNT_ID || !env.CF_REALTIME_APP_ID || !env.CF_REALTIME_APP_SECRET) {
    return c.json({ error: 'Missing CF_ACCOUNT_ID, CF_REALTIME_APP_ID, or CF_REALTIME_APP_SECRET' }, 400);
  }

  // Determine the webhook URL based on environment.
  // app-api hostnames (api-worker's map replaced): preview has no custom
  // domain, so it borrows the test hostname.
  const environment = env.ENVIRONMENT ?? 'development';
  const baseUrlMap: Record<string, string> = {
    production: 'https://app-api.weldsuite.org',
    preview: 'https://app-api-test.weldsuite.org',
    test: 'https://app-api-test.weldsuite.org',
  };
  const baseUrl = baseUrlMap[environment] ?? c.req.url.replace(/\/api\/webhooks\/cloudflare-realtime\/setup$/, '');
  // Register the receiver URL with the shared token when configured, so RTK
  // echoes it back on every event and forged (tokenless) calls are rejected.
  const token = env.CF_REALTIME_WEBHOOK_TOKEN;
  const webhookUrl = `${baseUrl}/api/webhooks/cloudflare-realtime${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/realtime/kit/${env.CF_REALTIME_APP_ID}/webhooks`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`,
      },
      body: JSON.stringify({
        name: `WeldSuite meeting lifecycle (${environment})`,
        url: webhookUrl,
        events: ['meeting.ended', 'meeting.participantLeft'],
        enabled: true,
      }),
    },
  );

  const result = await res.json();

  if (!res.ok) {
    console.error('[RTK Webhook Setup] Failed:', result);
    return c.json({ error: 'Failed to register webhook', details: result }, 500);
  }

  console.log(`[RTK Webhook Setup] Registered webhook for ${environment}: ${webhookUrl}`);
  return c.json({ ok: true, url: webhookUrl, result });
});

export const webhooksCloudflareRealtimeRoutes = app;
