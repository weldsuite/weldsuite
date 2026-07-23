/**
 * Telnyx Webhook Routes — PUBLIC (mounted before Clerk auth).
 *
 * Ported from apps/api-worker/src/routes/webhooks/telnyx.ts (W3 legacy
 * phase-out). Handles Telnyx Call Control webhooks for VoIP calls plus
 * porting.order.* status events. All events arrive as JSON at a single
 * endpoint.
 *
 * Key events:
 * - call.initiated — call started
 * - call.answered — callee picked up
 * - call.bridged — both parties connected
 * - call.hangup — call ended (credit settlement happens here)
 * - call.recording.saved — recording ready for download
 * - porting.order.* — bridged to the right tenant via the master-DB index
 *
 * SIGNATURE VERIFICATION: the legacy api-worker receiver performed NO
 * verification (TELNYX_WEBHOOK_SECRET was declared but never used). That
 * behaviour is preserved when TELNYX_PUBLIC_KEY is unset. When
 * TELNYX_PUBLIC_KEY (the account's base64 Ed25519 public key from the
 * Telnyx portal) IS set, signatures are enforced: requests missing or
 * failing `telnyx-signature-ed25519` / `telnyx-timestamp` are rejected 401.
 *
 * Entity events: intentionally not published here — the public route has no
 * authed Hono context (no tenantDb/workspaceId/userId vars), matching the
 * legacy receiver.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import {
  consumeCredits,
  grantCredits,
  resolveInternalWorkspaceId,
  SERVICE_CREDIT_RATES,
} from '@weldsuite/credits';
import { getTenantDbForWorkspace, getMasterDb, schema, masterSchema } from '../../db';
import { verifyTelnyxSignature, type TelnyxEnv } from '../../lib/telnyx';
import {
  handlePortingCompleted,
  handlePortingException,
  handlePortingCancelled,
} from '../../services/porting-completion';

// ============================================================================
// Types
// ============================================================================

interface TelnyxWebhookEvent {
  data: {
    event_type: string;
    id: string;
    occurred_at: string;
    payload: Record<string, any>;
    record_type: string;
  };
  meta: {
    attempt: number;
    delivered_to: string;
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Decode base64 client_state back to JSON string
 */
function decodeClientState(clientState?: string): Record<string, string> {
  if (!clientState) return {};
  try {
    return JSON.parse(atob(clientState));
  } catch {
    return {};
  }
}

/**
 * Dispatch a porting.order.* webhook to the right tenant DB by looking up
 * the workspace (clerkOrgId) on the master-DB index. Returns silently for
 * unknown order ids — those are almost always replays after we cleaned up
 * the index on completion/cancel.
 */
async function handlePortingWebhook(
  env: TelnyxEnv,
  eventType: string,
  payload: Record<string, any>,
): Promise<void> {
  const telnyxOrderId: string | undefined = payload.id;
  if (!telnyxOrderId) {
    console.warn('[Telnyx Webhook] Porting event without order id:', eventType);
    return;
  }

  const masterDb = getMasterDb(env);
  const [indexRow] = await masterDb
    .select()
    .from(masterSchema.telnyxPortingOrderIndex)
    .where(eq(masterSchema.telnyxPortingOrderIndex.telnyxPortingOrderId, telnyxOrderId))
    .limit(1);

  if (!indexRow) {
    // Either an unknown order or one we've already finalized + cleaned up.
    console.log(`[Telnyx Webhook] Porting order ${telnyxOrderId} not in index — ignoring`);
    return;
  }

  const ctx = {
    env,
    clerkOrgId: indexRow.clerkOrgId,
    draftId: indexRow.draftId,
    telnyxOrderId,
  };

  const status: string | undefined = payload.status;
  const subStatus: string | undefined = payload.sub_status;
  const messages: string[] = Array.isArray(payload.messages)
    ? payload.messages.map((m: any) => m?.message || m?.code || '').filter(Boolean)
    : [];

  console.log(`[Telnyx Webhook] Porting ${telnyxOrderId} → status=${status} sub=${subStatus}`);

  // Status names per Telnyx: draft | in-process | submitted | exception |
  // foc-date-confirmed | ported | cancelled | cancel-pending | etc. We
  // collapse to our internal terminal states.
  if (status === 'ported') {
    await handlePortingCompleted(ctx);
    return;
  }
  if (status === 'exception') {
    await handlePortingException(ctx, messages.join('; ') || subStatus || 'Telnyx flagged an exception');
    return;
  }
  if (status === 'cancelled') {
    await handlePortingCancelled(ctx);
    return;
  }

  // Non-terminal — just refresh substatus + actual FOC if present.
  const db = await getTenantDbForWorkspace(env, indexRow.clerkOrgId);
  await db
    .update(schema.voipPortingOrders)
    .set({
      substatus: subStatus ?? null,
      ...(payload.actual_foc_date ? { actualFocAt: new Date(payload.actual_foc_date) } : {}),
      // Map Telnyx in-process → our 'in_process' so the UI doesn't show
      // 'submitted' forever once Telnyx hands off to the losing carrier.
      ...(status === 'in-process' ? { status: 'in_process' } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.voipPortingOrders.id, indexRow.draftId));
}

/**
 * Map Telnyx hangup cause to internal status
 */
function mapHangupCause(cause: string): string {
  const causeMap: Record<string, string> = {
    normal_clearing: 'completed',
    originator_cancel: 'canceled',
    timeout: 'no_answer',
    busy: 'busy',
    call_rejected: 'failed',
    unallocated_number: 'failed',
    normal_unspecified: 'completed',
    user_busy: 'busy',
    no_user_response: 'no_answer',
    no_answer: 'no_answer',
  };
  return causeMap[cause] || 'completed';
}

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: TelnyxEnv }>();

/**
 * POST / — Single endpoint for all Telnyx Call Control events
 */
app.post('/', async (c) => {
  try {
    // Read raw body first so the (optional) signature check covers the exact
    // bytes Telnyx signed.
    const raw = await c.req.text();

    if (c.env.TELNYX_PUBLIC_KEY) {
      const valid = await verifyTelnyxSignature({
        publicKeyB64: c.env.TELNYX_PUBLIC_KEY,
        rawBody: raw,
        signatureB64: c.req.header('telnyx-signature-ed25519') ?? null,
        timestamp: c.req.header('telnyx-timestamp') ?? null,
      });
      if (!valid) {
        return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } }, 401);
      }
    }

    let event: TelnyxWebhookEvent;
    try {
      event = JSON.parse(raw) as TelnyxWebhookEvent;
    } catch {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
    }
    const { event_type, payload } = event.data;

    // ── Porting events ────────────────────────────────────────────────────
    // Porting webhooks carry no client_state. We bridge to the right tenant
    // DB via a master-DB index keyed on the Telnyx porting order id.
    if (event_type.startsWith('porting.order.')) {
      try {
        await handlePortingWebhook(c.env, event_type, payload);
      } catch (err) {
        // Always 200 — Telnyx retries on non-2xx and we'd rather log + heal
        // forward than build up a webhook backlog from a transient bug.
        console.error('[Telnyx Webhook] Porting handler threw:', err);
      }
      return c.json({ ok: true });
    }

    // Extract workspace/call context from client_state
    const clientState = decodeClientState(payload.client_state);
    const callId = clientState.callId;
    const workspaceId = clientState.workspaceId;

    const callControlId = payload.call_control_id;
    const callSessionId = payload.call_session_id;
    const callLegId = payload.call_leg_id;

    console.log(`[Telnyx Webhook] ${event_type} — callId=${callId}, callControlId=${callControlId}`);

    if (!callId || !workspaceId) {
      // No call context — can't update DB, just acknowledge
      console.warn(`[Telnyx Webhook] No callId/workspaceId in client_state for ${event_type}`);
      return c.json({ ok: true });
    }

    const db = await getTenantDbForWorkspace(c.env, workspaceId);
    const { voipCalls } = schema;

    switch (event_type) {
      case 'call.initiated': {
        await db
          .update(voipCalls)
          .set({
            providerCallId: callControlId,
            providerSessionId: callSessionId,
            providerLegId: callLegId,
            status: 'initiated',
            updatedAt: new Date(),
          })
          .where(eq(voipCalls.id, callId));
        break;
      }

      case 'call.answered': {
        await db
          .update(voipCalls)
          .set({
            status: 'answered',
            answeredAt: new Date(event.data.occurred_at),
            updatedAt: new Date(),
          })
          .where(eq(voipCalls.id, callId));

        // Start recording if requested via client_state
        if (clientState.record === 'true' && callControlId && c.env.TELNYX_API_KEY) {
          try {
            const recordResp = await fetch(
              `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${c.env.TELNYX_API_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  channels: 'dual',
                  format: 'mp3',
                }),
              },
            );
            if (!recordResp.ok) {
              const err = await recordResp.text();
              console.error(`[Telnyx Webhook] Failed to start recording: ${recordResp.status} ${err}`);
            } else {
              console.log(`[Telnyx Webhook] Recording started for call ${callId}`);
            }
          } catch (recErr) {
            console.error('[Telnyx Webhook] Recording start error:', recErr);
          }
        }
        break;
      }

      case 'call.bridged': {
        await db
          .update(voipCalls)
          .set({
            status: 'bridged',
            updatedAt: new Date(),
          })
          .where(eq(voipCalls.id, callId));
        break;
      }

      case 'call.hangup': {
        const hangupCause = payload.hangup_cause || 'normal_clearing';
        const hangupSource = payload.hangup_source || '';
        const sipCode = payload.sip_hangup_cause;

        // Calculate duration from start_time and end_time
        let duration: number | undefined;
        if (payload.start_time && payload.end_time) {
          const start = new Date(payload.start_time).getTime();
          const end = new Date(payload.end_time).getTime();
          duration = Math.round((end - start) / 1000);
        }

        const finalStatus = mapHangupCause(hangupCause);

        await db
          .update(voipCalls)
          .set({
            status: finalStatus,
            endedAt: new Date(event.data.occurred_at),
            duration,
            hangupCause: sipCode ? `SIP ${sipCode} - ${hangupCause}` : hangupCause,
            hangupSource,
            updatedAt: new Date(),
          })
          .where(eq(voipCalls.id, callId));

        if (duration && duration > 0) {
          console.log(`[Telnyx Webhook] Call ${callId} completed: ${duration}s`);

          // Settle the prepaid wallet per started minute via the shared credit
          // engine (@weldsuite/credits). Idempotent on the call id — webhook
          // replays and the app-api settle path can never double-charge. If
          // the balance drained mid-call the settlement forces the wallet
          // negative: visible debt beats hidden loss.
          try {
            const masterDb = getMasterDb(c.env);
            const internalWsId = await resolveInternalWorkspaceId(masterDb, workspaceId);
            if (internalWsId) {
              const minutes = Math.ceil(duration / 60);
              const cost = minutes * SERVICE_CREDIT_RATES.voipCallPerMinute;
              const settle = await consumeCredits(masterDb, {
                workspaceId: internalWsId,
                amount: cost,
                serviceType: 'voip_call',
                idempotencyKey: `voip:${callId}`,
                referenceId: callId,
                referenceType: 'voip_call',
                description: `VoIP call (${minutes} min)`,
                metadata: { callId, durationSecs: duration, hangupCause },
              });
              let transactionId = settle.ok ? settle.transactionId : null;
              if (!settle.ok) {
                const debit = await grantCredits(masterDb, {
                  workspaceId: internalWsId,
                  amount: -cost,
                  type: 'adjustment',
                  serviceType: 'voip_call',
                  idempotencyKey: `voip:${callId}`,
                  referenceId: callId,
                  referenceType: 'voip_call',
                  description: `VoIP call (${minutes} min) — settled into negative balance`,
                  metadata: { callId, durationSecs: duration, forcedSettlement: true },
                });
                transactionId = debit.transactionId;
              }
              await db
                .update(voipCalls)
                .set({ creditsConsumed: cost, creditTransactionId: transactionId, updatedAt: new Date() })
                .where(eq(voipCalls.id, callId));
            }
          } catch (settleErr) {
            console.error('[Telnyx Webhook] credit settlement FAILED (untracked call!):', settleErr);
          }
        }
        break;
      }

      case 'call.recording.saved': {
        const recordingUrl = payload.recording_urls?.mp3;
        const recordingDuration = payload.duration_secs
          ? Math.round(payload.duration_secs)
          : undefined;

        if (recordingUrl) {
          await db
            .update(voipCalls)
            .set({
              isRecorded: true,
              recordingStorageUrl: recordingUrl,
              recordingStorageKey: payload.recording_id || null,
              recordingDuration,
              updatedAt: new Date(),
            })
            .where(eq(voipCalls.id, callId));

          console.log(`[Telnyx Webhook] Recording saved for call ${callId}`);
        }
        break;
      }

      case 'call.machine.detection.ended': {
        console.log(`[Telnyx Webhook] AMD result for ${callId}: ${payload.result}`);
        break;
      }

      default: {
        console.log(`[Telnyx Webhook] Unhandled event: ${event_type}`);
      }
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error('[Telnyx Webhook] Error processing webhook:', err);
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

/**
 * GET / — Webhook verification
 */
app.get('/', (c) => {
  return c.json({ status: 'ok', message: 'Telnyx webhook endpoint' });
});

export { app as telnyxWebhookRoutes };
