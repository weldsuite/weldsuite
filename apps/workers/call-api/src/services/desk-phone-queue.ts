/**
 * The caller's side of a WeldDesk phone call that is offered to the team:
 * queue entry (`agents`), the unanswered path, and voicemail.
 *
 * `client_state` of the caller's leg is `{ callId, workspaceId,
 * deskConversationId?, record: 'false', voiceAgentId?, stage? }`. `stage`
 * says which step a command belongs to, because several `call.speak.ended` /
 * `call.recording.saved` events happen on one call:
 *   `menu`                keypad prompt playing (`call.gather.ended` follows)
 *   `queue`               parked in the Telnyx queue
 *   `voicemail_greeting`  greeting playing (`call.speak.ended` starts the recording)
 *   `voicemail`           recording the message (`call.recording.saved` ends the call)
 *   `call`                bridged to an agent, call recording on
 * `record` is always `false` here: these flows start recordings themselves.
 */

import { and, eq, isNull, or } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import {
  encodeClientState,
  telnyxAnswer,
  telnyxEnqueue,
  telnyxHangup,
  telnyxPlaybackStart,
  telnyxPlaybackStop,
  telnyxRecordStart,
  telnyxSpeak,
  type TelnyxEnv,
} from '../lib/telnyx';
import { ringbackUrl } from '../lib/desk-phone-audio';
import {
  PHONE_VOICE,
  defaultVoicemailGreeting,
  loadRouteForNumber,
  phoneQueueName,
  resolveRouteOptions,
  type ResolvedRouteOptions,
} from '../lib/desk-phone-options';
import { postPhoneMessage } from '../lib/desk-phone-messages';
import {
  endRingingLegs,
  loadCall,
  notifyPhoneEnded,
  publishPhoneQueueChange,
  ringAgents,
  staffedAgents,
  type PhoneCtx,
  type VoipCallRow,
} from './desk-phone-ring';

export type TelnyxFields = Record<string, unknown>;

/** What the flows need to command and describe one call. */
export interface CallFlowContext extends PhoneCtx {
  callId: string;
  /** The caller leg's call_control_id. */
  callControlId: string;
  conversationId: string | null;
  /** `{ callId, workspaceId, deskConversationId? }`: the client_state every command carries. */
  stateBase: Record<string, string>;
}

export function stateBaseOf(call: Pick<VoipCallRow, 'id' | 'deskConversationId'>, workspaceId: string): Record<string, string> {
  return {
    callId: call.id,
    workspaceId,
    ...(call.deskConversationId ? { deskConversationId: call.deskConversationId } : {}),
  };
}

/** The client_state for a command of these flows (`record` is always off). */
export function callState(ctx: Pick<CallFlowContext, 'stateBase'>, extra: Record<string, string> = {}): string {
  return encodeClientState({ ...ctx.stateBase, record: 'false', ...extra });
}

/** The flow context of a call row, or null when the caller leg has no call_control_id yet. */
export function flowContextOf(base: PhoneCtx, call: VoipCallRow): CallFlowContext | null {
  if (!call.providerCallId) return null;
  return {
    ...base,
    callId: call.id,
    callControlId: call.providerCallId,
    conversationId: call.deskConversationId,
    stateBase: stateBaseOf(call, base.workspaceId),
  };
}

export async function bestEffort(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.warn(`[desk-phone] ${label} failed:`, err);
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Ring the team: join the queue, play hold audio, ring the agents' browsers. */
export async function startAgentsFlow(
  ctx: CallFlowContext,
  input: { answered: boolean; options: ResolvedRouteOptions; departmentId: string | null },
): Promise<void> {
  const { env, db, callControlId } = ctx;
  const { options } = input;
  if (!input.answered) await telnyxAnswer(env, callControlId, { clientState: callState(ctx) });

  const c = schema.voipCalls;
  const now = new Date();
  // The conditional update is the guard: a duplicate event finds the call queued already.
  const [call] = await db
    .update(c)
    .set({ queueEnteredAt: now, departmentId: input.departmentId, updatedAt: now })
    .where(and(eq(c.id, ctx.callId), isNull(c.queueEnteredAt), isNull(c.outcome)))
    .returning();
  if (!call) return;

  // Nobody staffed: waiting would be pointless.
  if ((await staffedAgents(db, input.departmentId)).length === 0) {
    await handleUnanswered(ctx, 'nobody_staffed');
    return;
  }

  const greeting = options.greeting;
  if (greeting) {
    await bestEffort('queue greeting', () =>
      telnyxSpeak(env, callControlId, greeting, {
        voice: PHONE_VOICE,
        language: options.language,
        clientState: callState(ctx),
      }),
    );
  }
  try {
    // The queue's max wait is the caller's timer: Workers have no delayed jobs.
    await telnyxEnqueue(env, callControlId, {
      queueName: phoneQueueName(ctx.workspaceId, input.departmentId),
      maxWaitTimeSecs: options.maxWaitSeconds,
      clientState: callState(ctx, { stage: 'queue' }),
    });
  } catch (err) {
    console.error('[desk-phone] enqueue failed:', err);
    await handleUnanswered(ctx, 'enqueue_failed');
    return;
  }
  await bestEffort('hold audio', () =>
    telnyxPlaybackStart(env, callControlId, { audioUrl: ringbackUrl(env), loop: true }),
  );
  await publishPhoneQueueChange(env, db, ctx.workspaceId);
  await ringAgents(ctx, call, { ringSeconds: options.ringSeconds });
}

/**
 * Nobody answered in time (or nobody was staffed): stop the ringing, count the
 * call missed, then voicemail or hang up per the route. Idempotent: only the
 * event that moves the call from "no outcome" does anything.
 */
export async function handleUnanswered(ctx: CallFlowContext, reason: string): Promise<void> {
  const { env, db } = ctx;
  const c = schema.voipCalls;
  const [call] = await db
    .update(c)
    .set({ outcome: 'missed', updatedAt: new Date() })
    .where(and(eq(c.id, ctx.callId), isNull(c.outcome), isNull(c.agentAnsweredAt), isNull(c.endedAt)))
    .returning();
  if (!call) return;
  console.log(`[desk-phone] call ${ctx.callId} unanswered (${reason})`);

  const ended = await endRingingLegs(ctx, ctx.callId);
  await notifyPhoneEnded(ctx, ctx.callId, ended, 'timeout');
  await publishPhoneQueueChange(env, db, ctx.workspaceId);

  const options = resolveRouteOptions(await loadRouteForNumber(db, call.toNumber));
  if (options.whenUnanswered === 'voicemail') {
    await startVoicemail(ctx, { answered: true, fromQueue: true, options });
    return;
  }
  await bestEffort('hangup after no answer', () => telnyxHangup(env, ctx.callControlId));
  await postPhoneMessage(env, db, ctx.workspaceId, ctx.conversationId, {
    body: 'Missed call',
    metadata: { event: 'call_missed', callId: ctx.callId },
  });
}

/** Greeting, then (on `call.speak.ended`) the recording. */
export async function startVoicemail(
  ctx: CallFlowContext,
  input: { answered: boolean; fromQueue: boolean; options: ResolvedRouteOptions },
): Promise<void> {
  const { env, db, callControlId } = ctx;
  const { options } = input;
  if (!input.answered) await telnyxAnswer(env, callControlId, { clientState: callState(ctx) });

  const c = schema.voipCalls;
  await db
    .update(c)
    .set({ outcome: 'missed', updatedAt: new Date() })
    .where(and(eq(c.id, ctx.callId), isNull(c.outcome), isNull(c.agentAnsweredAt)));

  if (input.fromQueue) await bestEffort('hold audio stop', () => telnyxPlaybackStop(env, callControlId));

  const greeting = options.voicemailGreeting ?? defaultVoicemailGreeting(options.language);
  try {
    await telnyxSpeak(env, callControlId, greeting, {
      voice: PHONE_VOICE,
      language: options.language,
      clientState: callState(ctx, { stage: 'voicemail_greeting' }),
    });
  } catch (err) {
    // No greeting is no reason to lose the message: record straight away.
    console.warn('[desk-phone] voicemail greeting failed, recording without it:', err);
    await startVoicemailRecording(ctx);
  }
}

async function startVoicemailRecording(ctx: Pick<CallFlowContext, 'env' | 'callControlId' | 'stateBase'>): Promise<void> {
  await bestEffort('voicemail record_start', () =>
    telnyxRecordStart(ctx.env, ctx.callControlId, {
      channels: 'single',
      format: 'mp3',
      playBeep: true,
      maxLength: 180,
      clientState: callState(ctx, { stage: 'voicemail' }),
    }),
  );
}

/** What a webhook event of the caller's leg gives these handlers. */
export interface CallEventInput {
  env: TelnyxEnv;
  db: PhoneCtx['db'];
  workspaceId: string;
  callId: string;
  conversationId: string | undefined;
  clientState: Record<string, string>;
  payload: TelnyxFields;
}

/** `call.speak.ended` in the voicemail greeting stage starts the recording. */
export async function handleSpeakEnded(ev: CallEventInput): Promise<void> {
  if (ev.clientState.stage !== 'voicemail_greeting') return;
  const callControlId = asString(ev.payload.call_control_id);
  if (!callControlId) return;
  await startVoicemailRecording({
    env: ev.env,
    callControlId,
    stateBase: stateBaseOf({ id: ev.callId, deskConversationId: ev.conversationId ?? null }, ev.workspaceId),
  });
}

/** `call.dequeued`: only a timeout needs action (agents answering, the caller leaving and so on are handled elsewhere). */
export async function handleDequeued(ev: CallEventInput): Promise<void> {
  if (ev.payload.reason !== 'timeout') return;
  const call = await loadCall(ev.db, ev.callId);
  if (!call) return;
  const ctx = flowContextOf({ env: ev.env, db: ev.db, workspaceId: ev.workspaceId }, call);
  if (!ctx) return;
  await handleUnanswered(ctx, 'queue_timeout');
}

/**
 * A voicemail finished recording: the call's outcome is `voicemail`, the inbox
 * gets a message it can render as one, and the caller leg is hung up.
 */
export async function handleVoicemailSaved(
  ev: CallEventInput,
  recording: { url: string; duration: number | undefined },
): Promise<void> {
  const c = schema.voipCalls;
  const [saved] = await ev.db
    .update(c)
    .set({ outcome: 'voicemail', updatedAt: new Date() })
    .where(and(eq(c.id, ev.callId), or(isNull(c.outcome), eq(c.outcome, 'missed'))))
    .returning({ id: c.id });
  // A duplicate event finds the outcome set already: no second message.
  if (saved) {
    await postPhoneMessage(ev.env, ev.db, ev.workspaceId, ev.conversationId, {
      body: recording.duration ? `Voicemail (${recording.duration}s)` : 'Voicemail',
      metadata: {
        event: 'voicemail',
        callId: ev.callId,
        recordingUrl: recording.url,
        duration: recording.duration ?? null,
      },
    });
  }
  const callControlId = asString(ev.payload.call_control_id);
  if (callControlId) await bestEffort('hangup after voicemail', () => telnyxHangup(ev.env, callControlId));
}
