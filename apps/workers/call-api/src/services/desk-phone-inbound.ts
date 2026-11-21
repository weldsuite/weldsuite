/**
 * What an inbound call to a WeldDesk phone number does, per its route:
 * `forward`, `ai_agent`, `agents` (ring the team), `voicemail`, `menu` (a
 * keypad menu in front of the others) or hang up. The queue, ringing and
 * voicemail steps live in desk-phone-queue.ts and desk-phone-legs.ts.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DeskPhoneMenu, DeskPhoneMenuChoice } from '@weldsuite/db/schema/desk-phone-routes';
import { appendDeskMessage } from '@weldsuite/db/lib/desk';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  telnyxAiAssistantStart,
  telnyxAnswer,
  telnyxGatherUsingSpeak,
  telnyxHangup,
  telnyxRecordStart,
  telnyxTransfer,
  type TelnyxEnv,
} from '../lib/telnyx';
import { fanoutDeskPhoneMessage } from '../lib/desk-phone-fanout';
import { postPhoneMessage } from '../lib/desk-phone-messages';
import {
  PHONE_VOICE,
  invalidChoicePrompt,
  loadRouteForNumber,
  resolveRouteOptions,
  type PhoneRouteRow,
  type ResolvedRouteOptions,
} from '../lib/desk-phone-options';
import { signDeskPhoneToolToken } from '../lib/desk-phone-tool-auth';
import { buildDeskPhoneAssistantTools, callerContextInstructions, lookupCrmUrl } from '../lib/desk-phone-tools';
import { matchCallerByPhone } from './desk-phone-crm';
import { loadCall } from './desk-phone-ring';
import {
  asString,
  callState,
  flowContextOf,
  startAgentsFlow,
  startVoicemail,
  type CallEventInput,
  type CallFlowContext,
} from './desk-phone-queue';

export type PhoneNumberRow = typeof schema.voipPhoneNumbers.$inferSelect;
type DeskVoiceAgentRow = typeof schema.deskVoiceAgents.$inferSelect;

export function emptyCaller() {
  return {
    contactId: null as string | null,
    customerId: null as string | null,
    callerName: null as string | null,
    customerName: null as string | null,
    email: null as string | null,
    hits: [] as Awaited<ReturnType<typeof matchCallerByPhone>>['hits'],
  };
}

export type InboundCaller = ReturnType<typeof emptyCaller>;

export async function matchCallerSafe(db: Database, fromNumber: string): Promise<InboundCaller> {
  try {
    return await matchCallerByPhone(db, fromNumber);
  } catch (err) {
    console.error('[Telnyx Webhook] CRM caller match failed:', err);
    return emptyCaller();
  }
}

export interface InboundCallContext extends CallFlowContext {
  /** The client_state of the route's first command (the one a plain `ai_agent` or `forward` route sends). */
  clientState: string;
  toNumber: string;
  fromNumber: string;
  caller: InboundCaller;
  phoneRow: PhoneNumberRow;
}

async function forwardInboundCall(ctx: InboundCallContext, forwardToE164: string, clientState: string): Promise<void> {
  await telnyxTransfer(ctx.env, ctx.callControlId, forwardToE164, {
    clientState,
    from: ctx.toNumber,
  });
  await appendDeskMessage(ctx.db, {
    generateId,
    conversationId: ctx.conversationId!,
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
    conv: ctx.conversationId ?? undefined,
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

async function answerWithAiAgent(
  ctx: InboundCallContext,
  voiceAgentId: string,
  opts: { alreadyAnswered: boolean; clientState: string },
): Promise<void> {
  const { env, db, callControlId, callId, workspaceId, conversationId, fromNumber, caller } = ctx;
  const { clientState } = opts;
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

  if (!opts.alreadyAnswered) await telnyxAnswer(env, callControlId, { clientState });
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
    conversationId: conversationId!,
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
    conversationId: ctx.conversationId!,
    kind: 'message',
    authorType: 'system',
    body: 'Call ended (no inbound route configured)',
    metadata: { event: 'call_hangup_no_route', callId: ctx.callId },
  });
}

// ----------------------------------------------------------------------------
// Keypad menu
// ----------------------------------------------------------------------------

async function startMenu(ctx: InboundCallContext, options: ResolvedRouteOptions): Promise<void> {
  const menu = options.menu;
  if (!menu) return hangupCallWithoutRoute(ctx);
  await telnyxAnswer(ctx.env, ctx.callControlId, { clientState: callState(ctx) });
  await telnyxGatherUsingSpeak(ctx.env, ctx.callControlId, {
    payload: menu.prompt,
    voice: PHONE_VOICE,
    language: options.language,
    minimumDigits: 1,
    maximumDigits: 1,
    maximumTries: 2,
    timeoutMillis: 8000,
    validDigits: menu.choices.map((choice) => choice.digit).join(''),
    invalidPayload: invalidChoicePrompt(options.language),
    clientState: callState(ctx, { stage: 'menu' }),
  });
}

async function runMenuChoice(
  ctx: InboundCallContext,
  choice: DeskPhoneMenuChoice,
  options: ResolvedRouteOptions,
): Promise<void> {
  switch (choice.action) {
    case 'ai_agent':
      if (!choice.voiceAgentId) {
        await telnyxHangup(ctx.env, ctx.callControlId);
        return;
      }
      return answerWithAiAgent(ctx, choice.voiceAgentId, {
        alreadyAnswered: true,
        clientState: callState(ctx, { voiceAgentId: choice.voiceAgentId }),
      });
    case 'forward':
      if (!choice.forwardToE164) {
        await telnyxHangup(ctx.env, ctx.callControlId);
        return;
      }
      return forwardInboundCall(ctx, choice.forwardToE164, callState(ctx));
    case 'agents':
      return startAgentsFlow(ctx, { answered: true, options, departmentId: choice.departmentId ?? null });
    case 'voicemail':
      return startVoicemail(ctx, { answered: true, fromQueue: false, options });
  }
}

async function menuChoiceAlreadyRecorded(db: Database, conversationId: string, callId: string): Promise<boolean> {
  const m = schema.deskMessages;
  const [row] = await db
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.conversationId, conversationId),
        sql`${m.metadata}->>'event' = 'menu_choice'`,
        sql`${m.metadata}->>'callId' = ${callId}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The choice a gather result picks: the pressed key when it is on the menu, else the fallback choice. */
function pickMenuChoice(
  menu: DeskPhoneMenu,
  status: string | undefined,
  digits: string | undefined,
): { choice: DeskPhoneMenuChoice | undefined; fallback: boolean } {
  const pressed = status === 'valid' && digits ? menu.choices.find((c) => c.digit === digits) : undefined;
  if (pressed) return { choice: pressed, fallback: false };
  const choice = menu.fallbackDigit ? menu.choices.find((c) => c.digit === menu.fallbackDigit) : undefined;
  return { choice, fallback: true };
}

/** The timeline line of a menu choice: "Caller chose 1 (Sales)". */
async function postMenuChoice(ctx: InboundCallContext, choice: DeskPhoneMenuChoice, fallback: boolean): Promise<void> {
  const label = choice.label?.trim() || null;
  const named = label ? `${choice.digit} (${label})` : choice.digit;
  await postPhoneMessage(ctx.env, ctx.db, ctx.workspaceId, ctx.conversationId, {
    body: fallback ? `No valid choice, continuing with ${named}` : `Caller chose ${named}`,
    metadata: {
      event: 'menu_choice',
      callId: ctx.callId,
      digit: choice.digit,
      label,
      action: choice.action,
      ...(fallback ? { fallback: true } : {}),
    },
  });
}

/**
 * `call.gather.ended` of the menu prompt: run the pressed choice; for a key
 * that is not on the menu, or nothing pressed, the fallback choice, else hang up.
 */
export async function handleGatherEnded(ev: CallEventInput): Promise<void> {
  if (ev.clientState.stage !== 'menu') return;
  const status = asString(ev.payload.status);
  if (status === 'call_hangup' || status === 'cancelled') return;

  const { env, db, workspaceId } = ev;
  const call = await loadCall(db, ev.callId);
  if (!call) return;
  const ctx = await inboundContextOf(env, db, workspaceId, call);
  if (!ctx) return;
  const options = resolveRouteOptions(await loadRouteForNumber(db, call.toNumber));
  const menu = options.menu;

  try {
    if (!menu) {
      await telnyxHangup(env, ctx.callControlId);
      return;
    }
    const digits = asString(ev.payload.digits)?.trim();
    const { choice, fallback } = pickMenuChoice(menu, status, digits);

    if (!choice) {
      await postPhoneMessage(env, db, workspaceId, ctx.conversationId, {
        body: 'Caller made no menu choice',
        metadata: { event: 'menu_no_choice', callId: ctx.callId },
      });
      await telnyxHangup(env, ctx.callControlId);
      return;
    }

    // A retried event finds the choice written already.
    if (ctx.conversationId && (await menuChoiceAlreadyRecorded(db, ctx.conversationId, ctx.callId))) return;
    await postMenuChoice(ctx, choice, fallback);
    await runMenuChoice(ctx, choice, options);
  } catch (err) {
    console.error('[Telnyx Webhook] Menu choice failed:', err);
    try {
      await telnyxHangup(env, ctx.callControlId);
    } catch {
      /* ignore */
    }
  }
}

/** The inbound context of a call row, for events after the first (menu choice). */
async function inboundContextOf(
  env: TelnyxEnv,
  db: Database,
  workspaceId: string,
  call: NonNullable<Awaited<ReturnType<typeof loadCall>>>,
): Promise<InboundCallContext | null> {
  const flow = flowContextOf({ env, db, workspaceId }, call);
  if (!flow) return null;
  const [phoneRow] = await db
    .select()
    .from(schema.voipPhoneNumbers)
    .where(and(eq(schema.voipPhoneNumbers.phoneNumber, call.toNumber), isNull(schema.voipPhoneNumbers.deletedAt)))
    .limit(1);
  if (!phoneRow) return null;
  return {
    ...flow,
    clientState: callState(flow),
    toNumber: call.toNumber,
    fromNumber: call.fromNumber,
    caller: await matchCallerSafe(db, call.fromNumber),
    phoneRow,
  };
}

// ----------------------------------------------------------------------------
// The route
// ----------------------------------------------------------------------------

export async function executeInboundRoute(ctx: InboundCallContext, route: PhoneRouteRow | undefined): Promise<void> {
  const action = route?.action ?? 'hangup';
  const options = resolveRouteOptions(route);

  try {
    if (action === 'forward' && route?.forwardToE164) {
      await forwardInboundCall(ctx, route.forwardToE164, ctx.clientState);
      return;
    }

    if (action === 'ai_agent' && route?.voiceAgentId) {
      await answerWithAiAgent(ctx, route.voiceAgentId, { alreadyAnswered: false, clientState: ctx.clientState });
      return;
    }

    if (action === 'agents') {
      await startAgentsFlow(ctx, { answered: false, options, departmentId: options.departmentId });
      return;
    }

    if (action === 'voicemail') {
      await startVoicemail(ctx, { answered: false, fromQueue: false, options });
      return;
    }

    if (action === 'menu' && options.menu) {
      await startMenu(ctx, options);
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
