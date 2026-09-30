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
import { appendDeskMessage, ingestDeskPhone, getDeskConversation } from '@weldsuite/db/lib/desk';
import { getTenantDbForWorkspace, getMasterDb, schema, masterSchema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
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
import { generateId } from '@weldsuite/worker-kit/id';
import {
  handlePortingCompleted,
  handlePortingException,
  handlePortingCancelled,
} from '../../services/porting-completion';
import { matchCallerByPhone, lookupCrm, formatCrmLookupForAssistant } from '../../services/desk-phone-crm';
import { parseMessageHistory, syncAiTalkTranscript } from '../../services/desk-phone-transcript';
import { fanoutDeskPhoneMessage } from '../../lib/desk-phone-fanout';
import {
  bearerTokenFromHeader,
  verifyDeskPhoneToolToken,
  signDeskPhoneToolToken,
} from '../../lib/desk-phone-tool-auth';
import { buildDeskPhoneAssistantTools, callerContextInstructions, lookupCrmUrl } from '../../lib/desk-phone-tools';

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

async function syncLiveTranscript(args: {
  env: TelnyxEnv;
  db: Database;
  workspaceId: string;
  conversationId: string;
  callId: string;
  voiceAgentId?: string | null;
  visitorId?: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  const history = parseMessageHistory(args.payload);
  if (history.length === 0) return;

  const existing = await getDeskConversation(args.db, args.conversationId, {
    includeMessages: true,
  });
  if (!existing) return;

  const result = await syncAiTalkTranscript(args.db, {
    conversationId: args.conversationId,
    callId: args.callId,
    voiceAgentId: args.voiceAgentId,
    visitorId: args.visitorId ?? existing.conversation.visitorId,
    history,
    existingMessages: existing.messages,
  });

  for (const message of result.appended) {
    await fanoutDeskPhoneMessage({
      env: args.env,
      db: args.db,
      workspaceId: args.workspaceId,
      conversation: existing.conversation,
      message,
      action: 'created',
    });
  }
  for (const message of result.updated) {
    await fanoutDeskPhoneMessage({
      env: args.env,
      db: args.db,
      workspaceId: args.workspaceId,
      conversation: existing.conversation,
      message,
      action: 'updated',
    });
  }
}

type PhoneNumberRow = typeof schema.voipPhoneNumbers.$inferSelect;
type PhoneRouteRow = typeof schema.deskPhoneRoutes.$inferSelect;
type DeskVoiceAgentRow = typeof schema.deskVoiceAgents.$inferSelect;
type DeskIngestResult = Awaited<ReturnType<typeof ingestDeskPhone>>;

function emptyCaller() {
  return {
    contactId: null as string | null,
    customerId: null as string | null,
    callerName: null as string | null,
    customerName: null as string | null,
    email: null as string | null,
    hits: [] as Awaited<ReturnType<typeof matchCallerByPhone>>['hits'],
  };
}

type InboundCaller = ReturnType<typeof emptyCaller>;

interface InboundCallContext {
  env: TelnyxEnv;
  db: Database;
  callControlId: string;
  callId: string;
  workspaceId: string;
  conversationId: string;
  clientState: ReturnType<typeof encodeClientState>;
  toNumber: string;
  fromNumber: string;
  caller: InboundCaller;
  phoneRow: PhoneNumberRow;
}

async function hangupUnroutedCall(env: TelnyxEnv, callControlId: string, toNumber: string): Promise<void> {
  console.warn(`[Telnyx Webhook] No phone registry entry for ${toNumber} — hanging up`);
  try {
    await telnyxHangup(env, callControlId);
  } catch (err) {
    console.error('[Telnyx Webhook] Hangup after missing registry failed:', err);
  }
}

async function matchCallerSafe(db: Database, fromNumber: string): Promise<InboundCaller> {
  try {
    return await matchCallerByPhone(db, fromNumber);
  } catch (err) {
    console.error('[Telnyx Webhook] CRM caller match failed:', err);
    return emptyCaller();
  }
}

async function syncConversationCaller(
  db: Database,
  desk: DeskIngestResult,
  caller: InboundCaller,
  now: Date,
): Promise<void> {
  if (!caller.contactId) return;
  if (desk.conversation.contactId && desk.conversation.name === caller.callerName) return;
  await db
    .update(schema.deskConversations)
    .set({
      contactId: caller.contactId,
      name: caller.callerName ?? desk.conversation.name,
      email: caller.email ?? desk.conversation.email,
      updatedAt: now,
    })
    .where(eq(schema.deskConversations.id, desk.conversation.id));
}

async function forwardInboundCall(ctx: InboundCallContext, forwardToE164: string): Promise<void> {
  await telnyxTransfer(ctx.env, ctx.callControlId, forwardToE164, {
    clientState: ctx.clientState,
    from: ctx.toNumber,
  });
  await appendDeskMessage(ctx.db, {
    generateId,
    conversationId: ctx.conversationId,
    kind: 'message',
    authorType: 'system',
    body: `Forwarding call to ${forwardToE164}`,
    metadata: { event: 'call_forwarded', forwardToE164, callId: ctx.callId },
  });
}

async function buildAiAgentTools(
  ctx: InboundCallContext,
  agent: DeskVoiceAgentRow,
): Promise<unknown[] | undefined> {
  if (!ctx.env.TELNYX_API_KEY) return undefined;
  const token = await signDeskPhoneToolToken(ctx.env.TELNYX_API_KEY, {
    org: ctx.workspaceId,
    aid: agent.id,
    call: ctx.callId,
    conv: ctx.conversationId,
  });
  return buildDeskPhoneAssistantTools({
    transferToE164: agent.forwardToE164,
    lookupCrmUrl: lookupCrmUrl(ctx.env),
    toolAuthHeader: `Bearer ${token}`,
  });
}

async function startRecordingSafe(env: TelnyxEnv, callControlId: string): Promise<void> {
  try {
    await telnyxRecordStart(env, callControlId);
  } catch (recErr) {
    console.error('[Telnyx Webhook] record_start failed:', recErr);
  }
}

async function answerWithAiAgent(ctx: InboundCallContext, voiceAgentId: string): Promise<void> {
  const { env, db, callControlId, callId, workspaceId, conversationId, clientState, fromNumber, caller } = ctx;
  const { deskVoiceAgents } = schema;

  const [agent] = await db
    .select()
    .from(deskVoiceAgents)
    .where(and(eq(deskVoiceAgents.id, voiceAgentId), isNull(deskVoiceAgents.deletedAt)))
    .limit(1);

  if (!agent?.enabled || !agent.telnyxAssistantId) {
    console.warn(`[Telnyx Webhook] Voice agent ${voiceAgentId} unavailable — hangup`);
    await telnyxHangup(env, callControlId, { clientState });
    return;
  }

  const tools = await buildAiAgentTools(ctx, agent);

  const dynamicVariables: Record<string, string> = {
    caller_phone: fromNumber,
    ...(caller.callerName ? { caller_name: caller.callerName } : {}),
    ...(caller.customerName ? { customer_name: caller.customerName } : {}),
  };

  await telnyxAnswer(env, callControlId, { clientState });
  await telnyxAiAssistantStart(env, callControlId, agent.telnyxAssistantId, {
    clientState,
    sendMessageHistoryUpdates: true,
    instructions: callerContextInstructions({
      systemPrompt: agent.systemPrompt,
      callerPhone: fromNumber,
      callerName: caller.callerName,
      customerName: caller.customerName,
      contactId: caller.contactId,
      customerId: caller.customerId,
    }),
    tools,
    dynamicVariables,
  });

  if (ctx.phoneRow.enableRecording !== false) {
    await startRecordingSafe(env, callControlId);
  }

  const answered = await appendDeskMessage(db, {
    generateId,
    conversationId,
    kind: 'message',
    authorType: 'bot',
    authorId: agent.id,
    body: caller.callerName
      ? `AI agent “${agent.name}” answered the call (matched ${caller.callerName})`
      : `AI agent “${agent.name}” answered the call`,
    metadata: {
      event: 'ai_answered',
      voiceAgentId: agent.id,
      callId,
      contactId: caller.contactId,
      customerId: caller.customerId,
    },
  });
  await fanoutDeskPhoneMessage({
    env,
    db,
    workspaceId,
    conversation: answered.conversation,
    message: answered.message,
    action: 'created',
  });
}

async function hangupCallWithoutRoute(ctx: InboundCallContext): Promise<void> {
  await telnyxHangup(ctx.env, ctx.callControlId, { clientState: ctx.clientState });
  await appendDeskMessage(ctx.db, {
    generateId,
    conversationId: ctx.conversationId,
    kind: 'message',
    authorType: 'system',
    body: 'Call ended (no inbound route configured)',
    metadata: { event: 'call_hangup_no_route', callId: ctx.callId },
  });
}

async function executeInboundRoute(ctx: InboundCallContext, route: PhoneRouteRow | undefined): Promise<void> {
  const action = route?.action ?? 'hangup';

  try {
    if (action === 'forward' && route?.forwardToE164) {
      await forwardInboundCall(ctx, route.forwardToE164);
      return;
    }

    if (action === 'ai_agent' && route?.voiceAgentId) {
      await answerWithAiAgent(ctx, route.voiceAgentId);
      return;
    }

    await hangupCallWithoutRoute(ctx);
  } catch (err) {
    console.error('[Telnyx Webhook] Inbound route execution failed:', err);
    try {
      await telnyxHangup(ctx.env, ctx.callControlId, { clientState: ctx.clientState });
    } catch {
      /* ignore */
    }
  }
}

async function insertInboundCall(
  db: Database,
  args: {
    callId: string;
    now: Date;
    payload: TelnyxWebhookEvent['data']['payload'];
    callControlId: string;
    fromNumber: string;
    toNumber: string;
    conversationId: string;
    phoneRow: PhoneNumberRow;
    caller: InboundCaller;
  },
): Promise<void> {
  const { callId, now, payload, callControlId, fromNumber, toNumber, phoneRow, caller } = args;
  await db.insert(schema.voipCalls).values({
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
    deskConversationId: args.conversationId,
    isRecorded: phoneRow.enableRecording ?? true,
    customerId: caller.customerId,
    contactId: caller.contactId,
  });
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
    await hangupUnroutedCall(env, callControlId, toNumber);
    return;
  }

  const workspaceId = registry.clerkOrgId;
  const db = await getTenantDbForWorkspace(env, workspaceId);
  const { voipPhoneNumbers, deskPhoneRoutes } = schema;

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

  const caller = await matchCallerSafe(db, fromNumber);

  const desk = await ingestDeskPhone(db, {
    generateId,
    fromNumber,
    toNumber,
    callId,
    callControlId,
    name: caller.callerName,
    contactId: caller.contactId,
  });

  await syncConversationCaller(db, desk, caller, now);

  await insertInboundCall(db, {
    callId,
    now,
    payload,
    callControlId,
    fromNumber,
    toNumber,
    conversationId: desk.conversation.id,
    phoneRow,
    caller,
  });

  const clientState = encodeClientState({
    callId,
    workspaceId,
    deskConversationId: desk.conversation.id,
    record: phoneRow.enableRecording !== false ? 'true' : 'false',
    ...(route?.voiceAgentId ? { voiceAgentId: route.voiceAgentId } : {}),
  });

  await executeInboundRoute(
    {
      env,
      db,
      callControlId,
      callId,
      workspaceId,
      conversationId: desk.conversation.id,
      clientState,
      toNumber,
      fromNumber,
      caller,
      phoneRow,
    },
    route,
  );
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
// Tool route helpers
// ============================================================================

type ToolClaims = NonNullable<Awaited<ReturnType<typeof verifyDeskPhoneToolToken>>>;
type CrmLookupHits = Awaited<ReturnType<typeof lookupCrm>>;

async function readToolBody(readJson: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    const parsed = await readJson();
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* fall through to empty body */
  }
  return {};
}

function pickLookupQuery(body: Record<string, unknown>): string {
  return (
    (typeof body.query === 'string' && body.query) ||
    (typeof body.phone === 'string' && body.phone) ||
    (typeof body.email === 'string' && body.email) ||
    (typeof body.name === 'string' && body.name) ||
    ''
  );
}

async function resolveLookupQuery(db: Database, claims: ToolClaims, queryRaw: string): Promise<string> {
  const query = queryRaw.trim();
  if (query || !claims.call) return query;
  const [callRow] = await db
    .select({ fromNumber: schema.voipCalls.fromNumber })
    .from(schema.voipCalls)
    .where(eq(schema.voipCalls.id, claims.call))
    .limit(1);
  return callRow?.fromNumber ?? '';
}

async function appendCrmLookupNote(
  env: TelnyxEnv,
  db: Database,
  claims: ToolClaims,
  conversationId: string,
  query: string,
  hits: CrmLookupHits,
): Promise<void> {
  const summary =
    hits.length === 0
      ? `CRM lookup for “${query || 'unknown'}” returned no records`
      : `CRM lookup for “${query}”: ${hits.map((h) => `${h.name} (${h.type})`).join(', ')}`;
  try {
    const note = await appendDeskMessage(db, {
      generateId,
      conversationId,
      kind: 'note',
      authorType: 'bot',
      authorId: claims.aid,
      body: summary,
      metadata: { event: 'crm_lookup', query, callId: claims.call, hits: hits.map((h) => h.id) },
    });
    await fanoutDeskPhoneMessage({
      env,
      db,
      workspaceId: claims.org,
      conversation: note.conversation,
      message: note.message,
      action: 'created',
    });
  } catch (err) {
    console.error('[Telnyx tool] Failed to append CRM lookup note:', err);
  }
}

// ============================================================================
// Call Control event handlers
// ============================================================================

type TelnyxPayload = TelnyxWebhookEvent['data']['payload'];

interface CallEventContext {
  env: TelnyxEnv;
  db: Database;
  event: TelnyxWebhookEvent;
  payload: TelnyxPayload;
  clientState: Record<string, string>;
  callId: string;
  workspaceId: string;
  deskConversationId: string | undefined;
}

function computeCallDuration(payload: TelnyxPayload): number | undefined {
  if (!payload.start_time || !payload.end_time) return undefined;
  const start = new Date(payload.start_time).getTime();
  const end = new Date(payload.end_time).getTime();
  return Math.round((end - start) / 1000);
}

async function settleCallCredits(
  ctx: CallEventContext,
  duration: number,
  hangupCause: string,
): Promise<void> {
  const { env, db, callId, workspaceId } = ctx;
  try {
    const masterDb = getMasterDb(env);
    const internalWsId = await resolveInternalWorkspaceId(masterDb, workspaceId);
    if (!internalWsId) return;

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
      .update(schema.voipCalls)
      .set({ creditsConsumed: cost, creditTransactionId: transactionId, updatedAt: new Date() })
      .where(eq(schema.voipCalls.id, callId));
  } catch (settleErr) {
    console.error('[Telnyx Webhook] credit settlement FAILED (untracked call!):', settleErr);
  }
}

async function handleCallInitiatedEvent(ctx: CallEventContext): Promise<void> {
  const { payload } = ctx;
  await ctx.db
    .update(schema.voipCalls)
    .set({
      providerCallId: payload.call_control_id,
      providerSessionId: payload.call_session_id,
      providerLegId: payload.call_leg_id,
      status: 'initiated',
      updatedAt: new Date(),
    })
    .where(eq(schema.voipCalls.id, ctx.callId));
}

async function handleCallAnsweredEvent(ctx: CallEventContext): Promise<void> {
  const { env, callId } = ctx;
  const callControlId = ctx.payload.call_control_id;
  await ctx.db
    .update(schema.voipCalls)
    .set({
      status: 'answered',
      answeredAt: new Date(ctx.event.data.occurred_at),
      updatedAt: new Date(),
    })
    .where(eq(schema.voipCalls.id, callId));

  if (ctx.clientState.record === 'true' && callControlId && env.TELNYX_API_KEY) {
    try {
      await telnyxRecordStart(env, callControlId);
      console.log(`[Telnyx Webhook] Recording started for call ${callId}`);
    } catch (recErr) {
      console.error('[Telnyx Webhook] Recording start error:', recErr);
    }
  }
}

async function handleCallBridgedEvent(ctx: CallEventContext): Promise<void> {
  await ctx.db
    .update(schema.voipCalls)
    .set({
      status: 'bridged',
      updatedAt: new Date(),
    })
    .where(eq(schema.voipCalls.id, ctx.callId));
}

async function handleCallHangupEvent(ctx: CallEventContext): Promise<void> {
  const { env, db, payload, callId } = ctx;
  const hangupCause = payload.hangup_cause || 'normal_clearing';
  const hangupSource = payload.hangup_source || '';
  const sipCode = payload.sip_hangup_cause;
  const duration = computeCallDuration(payload);
  const finalStatus = mapHangupCause(hangupCause);

  await db
    .update(schema.voipCalls)
    .set({
      status: finalStatus,
      endedAt: new Date(ctx.event.data.occurred_at),
      duration,
      hangupCause: sipCode ? `SIP ${sipCode} - ${hangupCause}` : hangupCause,
      hangupSource,
      updatedAt: new Date(),
    })
    .where(eq(schema.voipCalls.id, callId));

  await appendDeskCallEvent(
    env,
    ctx.workspaceId,
    ctx.deskConversationId,
    `Call ended (${finalStatus}${duration ? `, ${duration}s` : ''})`,
    { event: 'call_ended', callId, hangupCause, duration },
  );

  if (duration && duration > 0) {
    console.log(`[Telnyx Webhook] Call ${callId} completed: ${duration}s`);
    await settleCallCredits(ctx, duration, hangupCause);
  }
}

async function handleRecordingSavedEvent(ctx: CallEventContext): Promise<void> {
  const { payload, callId } = ctx;
  const recordingUrl = payload.recording_urls?.mp3;
  if (!recordingUrl) return;

  const recordingDuration = payload.duration_secs ? Math.round(payload.duration_secs) : undefined;

  await ctx.db
    .update(schema.voipCalls)
    .set({
      isRecorded: true,
      recordingStorageUrl: recordingUrl,
      recordingStorageKey: payload.recording_id || null,
      recordingDuration,
      updatedAt: new Date(),
    })
    .where(eq(schema.voipCalls.id, callId));

  await appendDeskCallEvent(
    ctx.env,
    ctx.workspaceId,
    ctx.deskConversationId,
    'Call recording available',
    { event: 'recording_saved', callId, recordingUrl },
  );

  console.log(`[Telnyx Webhook] Recording saved for call ${callId}`);
}

async function handleTranscriptEvent(ctx: CallEventContext): Promise<void> {
  if (!ctx.deskConversationId) return;
  try {
    await syncLiveTranscript({
      env: ctx.env,
      db: ctx.db,
      workspaceId: ctx.workspaceId,
      conversationId: ctx.deskConversationId,
      callId: ctx.callId,
      voiceAgentId: ctx.clientState.voiceAgentId ?? null,
      payload: ctx.payload as Record<string, unknown>,
    });
  } catch (err) {
    console.error('[Telnyx Webhook] Live transcript sync failed:', err);
  }
}

async function handleInsightsGeneratedEvent(ctx: CallEventContext): Promise<void> {
  const { payload, callId } = ctx;
  const summary = payload.conversation_insights?.summary || payload.summary || null;
  if (!summary) return;

  await ctx.db
    .update(schema.voipCalls)
    .set({
      aiSummary: typeof summary === 'string' ? summary : JSON.stringify(summary),
      aiAnalyzedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.voipCalls.id, callId));

  await appendDeskCallEvent(
    ctx.env,
    ctx.workspaceId,
    ctx.deskConversationId,
    typeof summary === 'string' ? summary : 'AI call summary generated',
    { event: 'ai_summary', callId },
  );
}

async function dispatchCallEvent(eventType: string, ctx: CallEventContext): Promise<void> {
  switch (eventType) {
    case 'call.initiated':
      return handleCallInitiatedEvent(ctx);
    case 'call.answered':
      return handleCallAnsweredEvent(ctx);
    case 'call.bridged':
      return handleCallBridgedEvent(ctx);
    case 'call.hangup':
      return handleCallHangupEvent(ctx);
    case 'call.recording.saved':
      return handleRecordingSavedEvent(ctx);
    case 'call.ai_gather.message_history_updated':
    case 'call.conversation.ended':
      return handleTranscriptEvent(ctx);
    case 'call.conversation_insights.generated':
      return handleInsightsGeneratedEvent(ctx);
    case 'call.machine.detection.ended':
      console.log(`[Telnyx Webhook] AMD result for ${ctx.callId}: ${ctx.payload.result}`);
      return;
    default:
      console.log(`[Telnyx Webhook] Unhandled event: ${eventType}`);
  }
}

async function runPortingHandler(env: TelnyxEnv, eventType: string, payload: TelnyxPayload): Promise<void> {
  try {
    await handlePortingWebhook(env, eventType, payload);
  } catch (err) {
    console.error('[Telnyx Webhook] Porting handler threw:', err);
  }
}

async function runInboundHandler(env: TelnyxEnv, payload: TelnyxPayload): Promise<void> {
  try {
    await handleInboundInitiated(env, payload);
  } catch (err) {
    console.error('[Telnyx Webhook] Inbound handler threw:', err);
  }
}

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: TelnyxEnv }>();

/**
 * Telnyx AI Assistant webhook tool — not a Call Control event, so it uses
 * our HMAC Bearer token instead of Telnyx Ed25519 signatures.
 */
app.post('/tools/:toolName', async (c) => {
  const toolName = c.req.param('toolName');
  const secret = c.env.TELNYX_API_KEY;
  if (!secret) {
    return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Phone service is not activated' } }, 503);
  }

  const token = bearerTokenFromHeader(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing tool token' } }, 401);
  }
  const claims = await verifyDeskPhoneToolToken(secret, token);
  if (!claims) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid tool token' } }, 401);
  }

  if (toolName !== 'lookup_crm') {
    return c.json({ error: { code: 'NOT_FOUND', message: `Unknown tool ${toolName}` } }, 404);
  }

  const body = await readToolBody(() => c.req.json());
  const queryRaw = pickLookupQuery(body);

  try {
    const db = await getTenantDbForWorkspace(c.env, claims.org);
    const query = await resolveLookupQuery(db, claims, queryRaw);

    const hits = query ? await lookupCrm(db, query, 5) : [];
    const result = formatCrmLookupForAssistant(hits);

    if (claims.conv) {
      await appendCrmLookupNote(c.env, db, claims, claims.conv, query, hits);
    }

    return c.json(result);
  } catch (err) {
    console.error('[Telnyx tool] lookup_crm failed:', err);
    return c.json({ matched: 0, results: [], message: 'Lookup failed' }, 200);
  }
});

async function isTelnyxSignatureValid(
  env: TelnyxEnv,
  raw: string,
  signatureB64: string | null,
  timestamp: string | null,
): Promise<boolean> {
  if (!env.TELNYX_PUBLIC_KEY) return true;
  return verifyTelnyxSignature({
    publicKeyB64: env.TELNYX_PUBLIC_KEY,
    rawBody: raw,
    signatureB64,
    timestamp,
  });
}

app.post('/', async (c) => {
  try {
    const raw = await c.req.text();

    const signatureValid = await isTelnyxSignatureValid(
      c.env,
      raw,
      c.req.header('telnyx-signature-ed25519') ?? null,
      c.req.header('telnyx-timestamp') ?? null,
    );
    if (!signatureValid) {
      return c.json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } }, 401);
    }

    let event: TelnyxWebhookEvent;
    try {
      event = JSON.parse(raw) as TelnyxWebhookEvent;
    } catch {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400);
    }
    const { event_type, payload } = event.data;

    if (event_type.startsWith('porting.order.')) {
      await runPortingHandler(c.env, event_type, payload);
      return c.json({ ok: true });
    }

    const clientState = decodeClientState(payload.client_state);
    const { callId, workspaceId, deskConversationId } = clientState;

    console.log(`[Telnyx Webhook] ${event_type} — callId=${callId}, callControlId=${payload.call_control_id}`);

    // Inbound without client_state: route on call.initiated
    if ((!callId || !workspaceId) && event_type === 'call.initiated' && isInboundDirection(payload)) {
      await runInboundHandler(c.env, payload);
      return c.json({ ok: true });
    }

    if (!callId || !workspaceId) {
      console.warn(`[Telnyx Webhook] No callId/workspaceId in client_state for ${event_type}`);
      return c.json({ ok: true });
    }

    const db = await getTenantDbForWorkspace(c.env, workspaceId);

    await dispatchCallEvent(event_type, {
      env: c.env,
      db,
      event,
      payload,
      clientState,
      callId,
      workspaceId,
      deskConversationId,
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error('[Telnyx Webhook] Error processing webhook:', err);
    return c.json({ error: 'Webhook processing failed' }, 500);
  }
});

app.get('/', (c) => c.json({ status: 'ok', service: 'telnyx-webhook' }));

export { app as telnyxWebhookRoutes };
export default app;
