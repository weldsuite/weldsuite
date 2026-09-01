/**
 * Telnyx Webhook Routes — PUBLIC (mounted before Clerk auth).
 *
 * Handles Telnyx Call Control webhooks for VoIP calls plus porting.order.*
 * status events. Inbound calls without client_state are routed via the
 * master phone_number_registry → desk_phone_routes (AI / forward / hangup).
 */

import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import {
  consumeCredits,
  grantCredits,
  resolveInternalWorkspaceId,
  SERVICE_CREDIT_RATES,
} from '@weldsuite/credits';
import { appendDeskMessage, ingestDeskPhone } from '@weldsuite/db/lib/desk';
import { getTenantDbForWorkspace, getMasterDb, schema, masterSchema } from '../../db';
import {
  verifyTelnyxSignature,
  encodeClientState,
  telnyxAnswer,
  telnyxHangup,
  telnyxTransfer,
  telnyxAiAssistantStart,
  telnyxRecordStart,
  type TelnyxEnv,
} from '../../lib/telnyx';
import { lookupPhoneNumberRegistry, normalizeE164 } from '../../lib/phone-registry';
import { generateId } from '../../lib/id';
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

function decodeClientState(clientState?: string): Record<string, string> {
  if (!clientState) return {};
  try {
    return JSON.parse(atob(clientState));
  } catch {
    return {};
  }
}

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

  const db = await getTenantDbForWorkspace(env, indexRow.clerkOrgId);
  await db
    .update(schema.voipPortingOrders)
    .set({
      substatus: subStatus ?? null,
      ...(payload.actual_foc_date ? { actualFocAt: new Date(payload.actual_foc_date) } : {}),
      ...(status === 'in-process' ? { status: 'in_process' } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.voipPortingOrders.id, indexRow.draftId));
}

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

function isInboundDirection(payload: Record<string, any>): boolean {
  const dir = String(payload.direction || '').toLowerCase();
  return dir === 'incoming' || dir === 'inbound';
}

/**
 * Resolve dialed number → workspace route and execute Call Control action.
 */
async function handleInboundInitiated(
  env: TelnyxEnv,
  payload: Record<string, any>,
): Promise<void> {
  const callControlId: string | undefined = payload.call_control_id;
  const toRaw = payload.to || payload.callee || '';
  const fromRaw = payload.from || payload.caller_id_number || '';

  if (!callControlId || !toRaw) {
    console.warn('[Telnyx Webhook] Inbound initiated missing call_control_id or to');
    return;
  }

  const toNumber = normalizeE164(String(toRaw));
  const fromNumber = normalizeE164(String(fromRaw || 'unknown'));

  const masterDb = getMasterDb(env);
  const registry = await lookupPhoneNumberRegistry(masterDb, toNumber);
  if (!registry) {
    console.warn(`[Telnyx Webhook] No phone registry entry for ${toNumber} — hanging up`);
    try {
      await telnyxHangup(env, callControlId);
    } catch (err) {
      console.error('[Telnyx Webhook] Hangup after missing registry failed:', err);
    }
    return;
  }

  const workspaceId = registry.clerkOrgId;
  const db = await getTenantDbForWorkspace(env, workspaceId);
  const { voipPhoneNumbers, voipCalls, deskPhoneRoutes, deskVoiceAgents } = schema;

  const [phoneRow] = await db
    .select()
    .from(voipPhoneNumbers)
    .where(
      and(
        eq(voipPhoneNumbers.id, registry.voipPhoneNumberId),
        isNull(voipPhoneNumbers.deletedAt),
      ),
    )
    .limit(1);

  if (!phoneRow || phoneRow.allowInbound === false) {
    console.warn(`[Telnyx Webhook] Inbound not allowed for ${toNumber}`);
    await telnyxHangup(env, callControlId);
    return;
  }

  const [route] = await db
    .select()
    .from(deskPhoneRoutes)
    .where(eq(deskPhoneRoutes.voipPhoneNumberId, phoneRow.id))
    .limit(1);

  const callId = generateId('vcall');
  const now = new Date();

  const desk = await ingestDeskPhone(db, {
    generateId,
    fromNumber,
    toNumber,
    callId,
    callControlId,
  });

  await db.insert(voipCalls).values({
    id: callId,
    createdAt: now,
    updatedAt: now,
    userId: phoneRow.assignedUserId || 'system',
    provider: 'telnyx',
    providerCallId: callControlId,
    providerSessionId: payload.call_session_id ?? null,
    providerLegId: payload.call_leg_id ?? null,
    direction: 'inbound',
    status: 'initiated',
    fromNumber,
    toNumber,
    fromNumberFormatted: fromNumber,
    toNumberFormatted: toNumber,
    initiatedAt: now,
    deskConversationId: desk.conversation.id,
    isRecorded: phoneRow.enableRecording ?? true,
  });

  const clientState = encodeClientState({
    callId,
    workspaceId,
    deskConversationId: desk.conversation.id,
    record: phoneRow.enableRecording !== false ? 'true' : 'false',
  });

  const action = route?.action ?? 'hangup';

  try {
    if (action === 'forward' && route?.forwardToE164) {
      await telnyxTransfer(env, callControlId, route.forwardToE164, {
        clientState,
        from: toNumber,
      });
      await appendDeskMessage(db, {
        generateId,
        conversationId: desk.conversation.id,
        kind: 'message',
        authorType: 'system',
        body: `Forwarding call to ${route.forwardToE164}`,
        metadata: { event: 'call_forwarded', forwardToE164: route.forwardToE164, callId },
      });
      return;
    }

    if (action === 'ai_agent' && route?.voiceAgentId) {
      const [agent] = await db
        .select()
        .from(deskVoiceAgents)
        .where(
          and(
            eq(deskVoiceAgents.id, route.voiceAgentId),
            isNull(deskVoiceAgents.deletedAt),
          ),
        )
        .limit(1);

      if (!agent?.enabled || !agent.telnyxAssistantId) {
        console.warn(`[Telnyx Webhook] Voice agent ${route.voiceAgentId} unavailable — hangup`);
        await telnyxHangup(env, callControlId, { clientState });
        return;
      }

      await telnyxAnswer(env, callControlId, { clientState });
      await telnyxAiAssistantStart(env, callControlId, agent.telnyxAssistantId, { clientState });

      if (phoneRow.enableRecording !== false) {
        try {
          await telnyxRecordStart(env, callControlId);
        } catch (recErr) {
          console.error('[Telnyx Webhook] record_start failed:', recErr);
        }
      }

      await appendDeskMessage(db, {
        generateId,
        conversationId: desk.conversation.id,
        kind: 'message',
        authorType: 'bot',
        authorId: agent.id,
        body: `AI agent “${agent.name}” answered the call`,
        metadata: { event: 'ai_answered', voiceAgentId: agent.id, callId },
      });
      return;
    }

    await telnyxHangup(env, callControlId, { clientState });
    await appendDeskMessage(db, {
      generateId,
      conversationId: desk.conversation.id,
      kind: 'message',
      authorType: 'system',
      body: 'Call ended (no inbound route configured)',
      metadata: { event: 'call_hangup_no_route', callId },
    });
  } catch (err) {
    console.error('[Telnyx Webhook] Inbound route execution failed:', err);
    try {
      await telnyxHangup(env, callControlId, { clientState });
    } catch {
      /* ignore */
    }
  }
}

async function appendDeskCallEvent(
  env: TelnyxEnv,
  workspaceId: string,
  deskConversationId: string | undefined,
  body: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!deskConversationId) return;
  try {
    const db = await getTenantDbForWorkspace(env, workspaceId);
    await appendDeskMessage(db, {
      generateId,
      conversationId: deskConversationId,
      kind: 'message',
      authorType: 'system',
      body,
      metadata,
    });
  } catch (err) {
    console.error('[Telnyx Webhook] Failed to append desk call event:', err);
  }
}

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: TelnyxEnv }>();

app.post('/', async (c) => {
  try {
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

    if (event_type.startsWith('porting.order.')) {
      try {
        await handlePortingWebhook(c.env, event_type, payload);
      } catch (err) {
        console.error('[Telnyx Webhook] Porting handler threw:', err);
      }
      return c.json({ ok: true });
    }

    const clientState = decodeClientState(payload.client_state);
    let callId = clientState.callId;
    let workspaceId = clientState.workspaceId;
    const deskConversationId = clientState.deskConversationId;

    const callControlId = payload.call_control_id;
    const callSessionId = payload.call_session_id;
    const callLegId = payload.call_leg_id;

    console.log(`[Telnyx Webhook] ${event_type} — callId=${callId}, callControlId=${callControlId}`);

    // Inbound without client_state: route on call.initiated
    if ((!callId || !workspaceId) && event_type === 'call.initiated' && isInboundDirection(payload)) {
      try {
        await handleInboundInitiated(c.env, payload);
      } catch (err) {
        console.error('[Telnyx Webhook] Inbound handler threw:', err);
      }
      return c.json({ ok: true });
    }

    if (!callId || !workspaceId) {
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

        if (clientState.record === 'true' && callControlId && c.env.TELNYX_API_KEY) {
          try {
            await telnyxRecordStart(c.env, callControlId);
            console.log(`[Telnyx Webhook] Recording started for call ${callId}`);
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

        await appendDeskCallEvent(
          c.env,
          workspaceId,
          deskConversationId,
          `Call ended (${finalStatus}${duration ? `, ${duration}s` : ''})`,
          { event: 'call_ended', callId, hangupCause, duration },
        );

        if (duration && duration > 0) {
          console.log(`[Telnyx Webhook] Call ${callId} completed: ${duration}s`);

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

          await appendDeskCallEvent(
            c.env,
            workspaceId,
            deskConversationId,
            'Call recording available',
            { event: 'recording_saved', callId, recordingUrl },
          );

          console.log(`[Telnyx Webhook] Recording saved for call ${callId}`);
        }
        break;
      }

      case 'call.conversation_insights.generated': {
        const summary =
          payload.conversation_insights?.summary ||
          payload.summary ||
          null;
        if (summary) {
          await db
            .update(voipCalls)
            .set({
              aiSummary: typeof summary === 'string' ? summary : JSON.stringify(summary),
              aiAnalyzedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(voipCalls.id, callId));

          await appendDeskCallEvent(
            c.env,
            workspaceId,
            deskConversationId,
            typeof summary === 'string' ? summary : 'AI call summary generated',
            { event: 'ai_summary', callId },
          );
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

app.get('/', (c) => c.json({ status: 'ok', service: 'telnyx-webhook' }));

export { app as telnyxWebhookRoutes };
export default app;
