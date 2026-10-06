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
 * Handles meeting.ended, meeting.participantJoined and meeting.participantLeft
 * events from Cloudflare RealtimeKit. When RTK detects all participants have
 * left, it auto-ends the session (about a minute later) and fires
 * meeting.ended — that event is what ends an abandoned session on our side.
 *
 * Also the post-meeting events of RealtimeKit's own recorder, which arrive AFTER
 * the meeting ended (so the 24 h `rtk-meeting:` mapping is gone and they resolve
 * through the 14-day `rtk-session:` one): recording.statusUpdate,
 * meeting.transcript and meeting.summary. None of them downloads anything in
 * the request; copying and ingesting run in Workflows.
 *
 * KV mapping (written when RTK meetings are created):
 *   Key: rtk-meeting:{cfMeetingId}
 *   Value: { orgId, type: 'session'|'call', sessionId?, meetingId?, callId?, channelId? }
 *   Key: rtk-session:{cfMeetingId}   (sessions only, 14 days, never deleted at end)
 *   Value: { orgId, sessionId, meetingId }
 *
 * Response shape is the LEGACY `{ ok: true }` RTK expects (200 once the event
 * is accepted, so it is not retried) — intentionally NOT the `{ data }`
 * envelope.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getMasterDb, getTenantDbForWorkspace, masterSchema } from '@weldsuite/worker-kit/db';
import {
  BACKFILL_SESSIONS_PER_RUN,
  legacyRecordingCandidates,
} from '@weldsuite/meet-domain/workflows/backfill-legacy-recordings';
import type { Env, Variables } from '../../types';
import {
  POST_MEETING_EVENTS,
  handleMeetingEnded,
  handleMeetingSummary,
  handleMeetingTranscript,
  handleParticipantJoined,
  handleParticipantLeft,
  handleRecordingStatus,
  logPayloadShapeOnce,
  resolvePostMeetingMapping,
  type RtkWebhookEvent,
  type RtkMeetingMapping,
} from '../../services/rtk-webhook';
import { timingSafeEqualStr } from '@weldsuite/worker-kit/webhook-token';
import { logSafe } from '@weldsuite/worker-kit/log-safe';
import { upsertWebhook, type RtkWebhookEvent as RtkEventName } from '@weldsuite/cloudflare-realtime';
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

/** Events this receiver handles; `POST /setup` registers exactly these. */
export const WEBHOOK_EVENTS: RtkEventName[] = [
  'meeting.ended',
  'meeting.participantJoined',
  'meeting.participantLeft',
  'recording.statusUpdate',
  'meeting.transcript',
  'meeting.summary',
];

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Operator guard shared by the admin routes: `Authorization: Bearer
 * <CF_REALTIME_WEBHOOK_TOKEN>`, constant-time compare, refuses when the secret is
 * unset. Returns the 401 Response, or null when the caller is the operator.
 */
function rejectNonOperator(c: Context<{ Bindings: Env; Variables: Variables }>, label: string): Response | null {
  if (!c.env.CF_REALTIME_WEBHOOK_TOKEN) {
    console.error(`[RTK Webhook ${label}] Rejected: CF_REALTIME_WEBHOOK_TOKEN is not configured`);
    return c.json({ error: 'unauthorized' }, 401);
  }
  const auth = c.req.header('Authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!timingSafeEqualStr(provided, c.env.CF_REALTIME_WEBHOOK_TOKEN)) {
    console.warn(`[RTK Webhook ${label}] Rejected: missing/invalid bearer token`);
    return c.json({ error: 'unauthorized' }, 401);
  }
  return null;
}

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
    // Documented payloads nest the id under `meeting`; older ones sent it flat;
    // recording events carry it under `recording.meetingId` as well.
    const rtkMeetingId = event.meeting?.id ?? event.recording?.meetingId ?? event.meetingId;

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

    // Post-meeting events (recorder, transcript, summary) resolve through the
    // long-lived mapping and are handled on their own path.
    if (POST_MEETING_EVENTS.has(eventType)) {
      logPayloadShapeOnce(event);
      const mapping = await resolvePostMeetingMapping(c.env, event);
      if (!mapping) {
        // Chat call, unknown meeting or an expired mapping — acknowledge.
        console.info(`[RTK Webhook] No session mapping for ${logSafe(rtkMeetingId)} (${logSafe(eventType)}), skipping`);
        return c.json({ ok: true });
      }
      switch (eventType) {
        case 'recording.statusUpdate':
          await handleRecordingStatus(c.env, mapping, event);
          break;
        case 'meeting.transcript':
          await handleMeetingTranscript(c.env, mapping, event);
          break;
        case 'meeting.summary':
          await handleMeetingSummary(c.env, mapping, event);
          break;
      }
      if (dedupeKey) {
        await c.env.WORKSPACE_CACHE.put(dedupeKey, '1', { expirationTtl: DELIVERY_DEDUPE_TTL_SECONDS });
      }
      return c.json({ ok: true });
    }

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

      case 'meeting.participantJoined':
        await handleParticipantJoined(c.env, raw, event);
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
 * and refuses when that secret is unset. Idempotent: the webhook with this
 * URL has its event list replaced (duplicates from the old create-only setup
 * are deleted); only when none exists is one created. Re-run it once per
 * environment after deploying a change to the event list.
 */
app.post('/setup', async (c) => {
  const env = c.env;

  const rejected = rejectNonOperator(c, 'Setup');
  if (rejected) return rejected;

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

  let result: Awaited<ReturnType<typeof upsertWebhook>>;
  try {
    result = await upsertWebhook(env, {
      name: `WeldSuite meeting lifecycle (${environment})`,
      url: webhookUrl,
      events: [...WEBHOOK_EVENTS],
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

  console.info(`[RTK Webhook Setup] ${result.action} webhook for ${environment}: ${webhookUrl}`);
  return c.json({
    ok: true,
    url: webhookUrl,
    id: result.id,
    action: result.action,
    removedDuplicates: result.removedDuplicates,
    events: WEBHOOK_EVENTS,
  });
});

// ============================================================================
// POST /backfill-recordings — one-off legacy recording backfill (operator only)
// ============================================================================

const backfillBodySchema = z.object({
  /** Limit to one workspace (Clerk org id). Omit for every active workspace. */
  orgId: z.string().min(1).max(100).optional(),
  /** Count candidates per workspace, dispatch nothing. */
  dryRun: z.boolean().optional(),
});

interface BackfillWorkspaceResult {
  orgId: string;
  /** Legacy sessions still without a recording status (capped at the per-run limit). */
  candidates: number;
  instanceId?: string;
  error?: string;
}

/**
 * Before RealtimeKit's own recorder, a session's recording was only an expiring
 * Cloudflare URL / marker with `recording_status` null. RealtimeKit keeps recordings
 * about 7 days, so run this right after the first deploy of each env.
 *
 * Operator-only (same bearer as /setup). Body `{ "orgId"?: string, "dryRun"?: boolean }`.
 * Per workspace with candidates it starts one BackfillLegacyRecordingsWorkflow
 * (MEETING_RECORDING_BACKFILL) that, per session, queues the copy of what
 * RealtimeKit still has into MEETING_RECORDINGS or marks it `unavailable`.
 * Idempotent: re-running only finds sessions that still have no status, and copy
 * instances have deterministic ids. A workspace with more than
 * ${BACKFILL_SESSIONS_PER_RUN} candidates needs another run.
 */
app.post('/backfill-recordings', async (c) => {
  const rejected = rejectNonOperator(c, 'Backfill');
  if (rejected) return rejected;

  let raw: unknown = {};
  try {
    raw = await c.req.json();
  } catch {
    /* no body is fine */
  }
  const parsed = backfillBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400);
  const { orgId, dryRun = false } = parsed.data;

  if (!dryRun && !c.env.MEETING_RECORDING_BACKFILL) {
    return c.json({ error: 'MEETING_RECORDING_BACKFILL binding is not configured' }, 503);
  }

  let orgIds: string[];
  if (orgId) {
    orgIds = [orgId];
  } else {
    const rows = await getMasterDb(c.env)
      .select({ clerkOrgId: masterSchema.workspaces.clerkOrgId })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.isActive, true));
    orgIds = rows.map((r) => r.clerkOrgId).filter((id): id is string => Boolean(id));
  }

  const stamp = Date.now().toString(36);
  const results: BackfillWorkspaceResult[] = [];
  for (const org of orgIds) {
    const result: BackfillWorkspaceResult = { orgId: org, candidates: 0 };
    try {
      const db = await getTenantDbForWorkspace(c.env, org);
      result.candidates = (await legacyRecordingCandidates(db, BACKFILL_SESSIONS_PER_RUN)).length;
      if (!dryRun && result.candidates > 0) {
        const instanceId = `bf-${org.slice(0, 40)}-${stamp}`;
        await c.env.MEETING_RECORDING_BACKFILL!.create({ id: instanceId, params: { orgId: org } });
        result.instanceId = instanceId;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`[RTK Webhook Backfill] ${logSafe(org)} failed: ${result.error}`);
    }
    results.push(result);
  }

  return c.json({
    ok: true,
    dryRun,
    workspaces: results.length,
    candidates: results.reduce((sum, r) => sum + r.candidates, 0),
    dispatched: results.filter((r) => r.instanceId).length,
    failed: results.filter((r) => r.error).length,
    perRunLimit: BACKFILL_SESSIONS_PER_RUN,
    results,
  });
});

export const webhooksCloudflareRealtimeRoutes = app;
