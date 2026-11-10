/**
 * Webhook events of the legs the server dialled to ring agents' browsers
 * (`client_state` has `agentLegId`), and the caller hanging up while waiting.
 *
 * Every state change is a conditional update, so a duplicate or out-of-order
 * event finds the work done and does nothing. Telnyx commands that fail
 * because a leg is gone are logged and swallowed.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { appendDeskMessage } from '@weldsuite/db/lib/desk';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { encodeClientState, telnyxBridge, telnyxPlaybackStop, telnyxRecordStart, type TelnyxEnv } from '../lib/telnyx';
import { sendPhoneInboxEvent } from '../lib/desk-phone-realtime';
import { loadRouteForNumber, resolveRouteOptions } from '../lib/desk-phone-options';
import { fanoutDeskPhoneMessage } from '../lib/desk-phone-fanout';
import { memberDisplayName, postPhoneMessage } from '../lib/desk-phone-messages';
import { bestEffort, asString, type CallEventInput, type TelnyxFields } from './desk-phone-queue';
import {
  MIN_RING_MS_FOR_NEXT_ROUND,
  endLeg,
  endRingingLegs,
  hangupBestEffort,
  loadCall,
  loadWaitingCall,
  notifyPhoneEnded,
  publishPhoneQueueChange,
  ringAgents,
  ringWaitingCalls,
  type PhoneCtx,
  type VoipCallRow,
} from './desk-phone-ring';

type LegRow = typeof schema.deskPhoneCallLegs.$inferSelect;

export interface AgentLegEvent {
  env: TelnyxEnv;
  db: PhoneCtx['db'];
  workspaceId: string;
  eventType: string;
  legId: string;
  payload: TelnyxFields;
}

/** Route an event of an agent leg. */
export async function handleAgentLegEvent(ev: AgentLegEvent): Promise<void> {
  const { db } = ev;
  const l = schema.deskPhoneCallLegs;
  const [leg] = await db.select().from(l).where(eq(l.id, ev.legId)).limit(1);
  if (!leg) {
    console.warn(`[desk-phone] event ${ev.eventType} for unknown agent leg ${ev.legId}`);
    return;
  }
  const legCallControlId = asString(ev.payload.call_control_id);

  if ((ev.eventType === 'call.initiated' || ev.eventType === 'call.answered') && legCallControlId) {
    await db
      .update(l)
      .set({ providerCallId: legCallControlId })
      .where(and(eq(l.id, leg.id), isNull(l.providerCallId)));
  }
  const ctx: PhoneCtx = { env: ev.env, db, workspaceId: ev.workspaceId };
  const providerCallId = leg.providerCallId ?? legCallControlId ?? null;

  if (ev.eventType === 'call.answered') await onAgentAnswered(ctx, leg, providerCallId);
  else if (ev.eventType === 'call.hangup') await onAgentHangup(ctx, leg);
}

/** The agent accepted in the browser: the first one wins the call. */
async function onAgentAnswered(ctx: PhoneCtx, leg: LegRow, agentCallControlId: string | null): Promise<void> {
  const { env, db, workspaceId } = ctx;
  const c = schema.voipCalls;
  const now = new Date();
  const previousUserId = (await loadCall(db, leg.callId))?.userId ?? 'system';
  const [won] = await db
    .update(c)
    .set({ agentAnsweredAt: now, answeredByUserId: leg.userId, userId: leg.userId, outcome: 'answered', updatedAt: now })
    .where(and(eq(c.id, leg.callId), isNull(c.agentAnsweredAt), isNull(c.endedAt), isNull(c.outcome)))
    .returning();

  if (!won) {
    // The same event delivered twice for the winner must not hang the winner up.
    const call = await loadCall(db, leg.callId);
    if (call?.answeredByUserId === leg.userId) return;
    await endLeg(db, leg.id);
    await hangupBestEffort(env, agentCallControlId);
    return;
  }

  const callerCallControlId = won.providerCallId;
  let bridged = false;
  if (callerCallControlId && agentCallControlId) {
    try {
      await telnyxBridge(env, agentCallControlId, callerCallControlId);
      bridged = true;
    } catch (err) {
      console.error(`[desk-phone] bridge of call ${won.id} failed:`, err);
    }
  } else {
    console.error(`[desk-phone] call ${won.id} cannot be bridged: missing call_control_id`);
  }
  if (!bridged) {
    // Nobody is on the call: give it back to the queue. The other ringing legs are untouched.
    await endLeg(db, leg.id);
    await hangupBestEffort(env, agentCallControlId);
    await db
      .update(c)
      .set({ agentAnsweredAt: null, answeredByUserId: null, outcome: null, userId: previousUserId, updatedAt: new Date() })
      .where(and(eq(c.id, won.id), eq(c.answeredByUserId, leg.userId), isNull(c.endedAt)));
    await sendPhoneInboxEvent(env, workspaceId, leg.userId, 'phone.ended', { callId: won.id, reason: 'timeout' });
    await publishPhoneQueueChange(env, db, workspaceId);
    await ringWaitingCalls(ctx);
    return;
  }

  const l = schema.deskPhoneCallLegs;
  await db
    .update(l)
    .set({ status: 'answered' })
    .where(and(eq(l.id, leg.id), eq(l.status, 'ringing')));

  if (callerCallControlId) {
    await bestEffort('hold audio stop', () => telnyxPlaybackStop(env, callerCallControlId));
    if (won.isRecorded) {
      await bestEffort('call record_start', () =>
        telnyxRecordStart(env, callerCallControlId, {
          channels: 'dual',
          format: 'mp3',
          clientState: encodeClientState({
            callId: won.id,
            workspaceId,
            ...(won.deskConversationId ? { deskConversationId: won.deskConversationId } : {}),
            record: 'false',
            stage: 'call',
          }),
        }),
      );
    }
  }

  const others = await endRingingLegs(ctx, won.id, leg.id);
  await notifyPhoneEnded(ctx, won.id, others, 'answered_elsewhere');
  await sendPhoneInboxEvent(env, workspaceId, leg.userId, 'phone.answered', {
    callId: won.id,
    conversationId: won.deskConversationId,
    answeredByUserId: leg.userId,
  });
  await publishPhoneQueueChange(env, db, workspaceId);
  await recordAnswer(ctx, won, leg.userId);
}

/** Give the conversation to the answerer (when nobody owns it) and say who answered. */
async function recordAnswer(ctx: PhoneCtx, call: VoipCallRow, userId: string): Promise<void> {
  const { env, db, workspaceId } = ctx;
  const conversationId = call.deskConversationId;
  if (!conversationId) return;
  try {
    const conv = schema.deskConversations;
    const claimed = await db
      .update(conv)
      .set({ assigneeId: userId, updatedAt: new Date() })
      .where(and(eq(conv.id, conversationId), isNull(conv.assigneeId)))
      .returning({ id: conv.id });
    if (claimed.length > 0) {
      const assigned = await appendDeskMessage(db, {
        generateId,
        conversationId,
        kind: 'event',
        authorType: 'system',
        metadata: { eventType: 'assigned', assigneeId: userId, via: 'phone' },
        assigneeId: userId,
      });
      await publishEntityEventRaw({
        env,
        db,
        workspaceId,
        userId: 'system',
        entityType: 'desk_conversation',
        action: 'assigned',
        entityId: assigned.conversation.id,
        data: assigned.conversation as unknown as Record<string, unknown>,
        source: 'system',
      });
      await fanoutDeskPhoneMessage({
        env,
        db,
        workspaceId,
        conversation: assigned.conversation,
        message: assigned.message,
        action: 'created',
      });
    }
  } catch (err) {
    console.error('[desk-phone] assigning the conversation failed:', err);
  }
  const name = await memberDisplayName(db, userId).catch(() => null);
  await postPhoneMessage(env, db, workspaceId, conversationId, {
    body: `Call answered by ${name ?? 'an agent'}`,
    metadata: { event: 'call_answered', callId: call.id, userId },
  });
}

/** An agent leg ended: hang the caller up with an answered leg, or ring on when everyone let it ring out. */
async function onAgentHangup(ctx: PhoneCtx, leg: LegRow): Promise<void> {
  const { env, db } = ctx;
  if (!(await endLeg(db, leg.id))) return;
  const call = await loadCall(db, leg.callId);
  if (!call) return;

  if (leg.status === 'answered') {
    await hangupBestEffort(env, call.providerCallId);
    // The agent is free: offer them the oldest waiting caller.
    await ringWaitingCalls(ctx, { finishedCallId: call.id });
    return;
  }

  // A round has ended only when no other leg of it is still ringing.
  const l = schema.deskPhoneCallLegs;
  const [ringing] = await db
    .select({ n: sql<number>`count(*)` })
    .from(l)
    .where(and(eq(l.callId, call.id), eq(l.status, 'ringing')));
  if (Number(ringing?.n ?? 0) > 0) return;
  if (!(await loadWaitingCall(db, call.id))) {
    // This call is settled: the members who were ringing for it can take the next caller.
    await ringWaitingCalls(ctx);
    return;
  }
  // A leg that failed at once (a broken credential) must not spin a dial loop.
  if (Date.now() - leg.createdAt.getTime() < MIN_RING_MS_FOR_NEXT_ROUND) return;

  const options = resolveRouteOptions(await loadRouteForNumber(db, call.toNumber));
  await ringAgents(ctx, call, { ringSeconds: options.ringSeconds });
}

/**
 * The caller's `call.hangup`, for a call that was waiting for an agent: it is
 * abandoned, the ringing browsers stop and the queue count drops.
 */
export async function handleCallerLeftQueue(ev: CallEventInput): Promise<void> {
  const c = schema.voipCalls;
  const [abandoned] = await ev.db
    .update(c)
    .set({ outcome: 'abandoned', updatedAt: new Date() })
    .where(and(eq(c.id, ev.callId), isNotNull(c.queueEnteredAt), isNull(c.agentAnsweredAt), isNull(c.outcome)))
    .returning({ id: c.id });
  if (!abandoned) return;
  const ctx: PhoneCtx = { env: ev.env, db: ev.db, workspaceId: ev.workspaceId };
  const ended = await endRingingLegs(ctx, ev.callId);
  await notifyPhoneEnded(ctx, ev.callId, ended, 'caller_hung_up');
  await publishPhoneQueueChange(ev.env, ev.db, ev.workspaceId);
}
