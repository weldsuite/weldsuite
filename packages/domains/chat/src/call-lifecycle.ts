/**
 * WeldChat — End Call lifecycle.
 *
 * Ported from api-worker's services/meeting-lifecycle.ts (WeldChat section).
 * Context-free function for ending a chat call: marks the row ended, ends the
 * Cloudflare RealtimeKit meeting, cleans up the KV mapping, posts the
 * "Call ended" system message, and publishes the realtime events.
 *
 * When an unanswered DM call ends (nobody but the initiator joined, or it was
 * still ringing), also delivers `chat_missed_call` push to other members so a
 * killed-app callee gets a "missed call" after ring timeout / caller hangup.
 *
 * Shared by chat (chat-calls routes, still in app-api) and meet (the RTK
 * webhook in meet-api), hence a package (docs/plans/app-api-module-split.md).
 *
 * Only an explicit hang-up-for-all or a decline ends a call unconditionally.
 * Everything automatic asks RealtimeKit first: see {@link endChatCallIfEmpty}.
 */

import { eq } from 'drizzle-orm';
import {
  endMeeting as endRtkMeeting,
  getLiveParticipantCount,
  kickAllParticipants as kickAllRtkParticipants,
} from '@weldsuite/cloudflare-realtime';
import { sendMissedCallNotification } from '@weldsuite/notifications';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { CloudflareRealtimeEnv, RealtimeKvNamespace } from '@weldsuite/cloudflare-realtime';
import type { NotificationEnv } from '@weldsuite/notifications';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  publishChatCallEnded,
  broadcastChatCallToMembers,
  type WeldChatCallPublisherEnv,
} from './realtime/weldchat-call-publisher';

/**
 * The bindings the call lifecycle reads: the RealtimeKit credentials, the
 * `rtk-meeting:*` KV mapping, the realtime fan-out and the missed-call
 * notification keys. Any worker Env with them fits.
 */
export interface CallLifecycleEnv
  extends CloudflareRealtimeEnv,
    NotificationEnv,
    WeldChatCallPublisherEnv {
  WORKSPACE_CACHE: KVNamespace;
}

/**
 * How long a DM call rings before it counts as missed. `scheduleRingTimeout`
 * runs inside `waitUntil`, which Workers cancel ~30s after the response, so
 * this must stay under that budget. At 60s the timeout never fired: unanswered
 * calls stayed "active" and silently swallowed the next call in the DM.
 */
export const RING_TIMEOUT_MS = 25_000;

/** True once anyone other than the initiator has joined the call. */
export function wasAnswered(call: {
  initiatorId: string;
  participants?: ChatCallParticipant[] | null;
}): boolean {
  return (call.participants ?? []).some((p) => p.userId !== call.initiatorId && !!p.joinedAt);
}

/**
 * Tear down a call's RealtimeKit room: kick everyone, end the meeting, drop the
 * `rtk-meeting:<id>` KV mapping. Deactivating a meeting alone does not
 * disconnect live participants, so a caller who stays in the room would keep
 * talking after the call is over; kick-all first closes that.
 *
 * Every step is best effort and independent (the DB row is the source of
 * truth): a failing kick never skips the end, a failing end never skips the KV
 * cleanup. Failures are logged with the call id and RTK meeting id. A kick on
 * an empty or already-inactive room may be rejected, which is expected.
 */
export async function teardownRtkMeeting(
  env: Omit<CloudflareRealtimeEnv, 'WORKSPACE_CACHE'> & {
    WORKSPACE_CACHE?: RealtimeKvNamespace & { delete(key: string): Promise<unknown> };
  },
  cfAppId: string,
  logCtx: { callId: string },
): Promise<void> {
  try {
    await kickAllRtkParticipants(env, cfAppId);
  } catch (err) {
    console.error('[CallLifecycle] RTK kick-all failed', { callId: logCtx.callId, cfAppId, err });
  }
  try {
    await endRtkMeeting(env, cfAppId);
  } catch (err) {
    console.error('[CallLifecycle] RTK end meeting failed', { callId: logCtx.callId, cfAppId, err });
  }
  try {
    await env.WORKSPACE_CACHE?.delete(`rtk-meeting:${cfAppId}`);
  } catch (err) {
    console.error('[CallLifecycle] KV mapping cleanup failed', { callId: logCtx.callId, cfAppId, err });
  }
}

export async function endChatCall(
  db: Database,
  env: CallLifecycleEnv,
  orgId: string,
  callId: string,
  call: {
    startedAt: Date | null;
    cfAppId: string | null;
    channelId: string;
    initiatorId: string;
    initiatorName: string;
    status?: string;
    callType?: string;
    participants?: ChatCallParticipant[] | null;
  },
  endedBy: string,
  options?: { sendMissedIfUnanswered?: boolean },
): Promise<void> {
  const { chatCalls, chatMessages } = schema;

  const now = new Date();
  const duration = call.startedAt
    ? Math.round((now.getTime() - new Date(call.startedAt).getTime()) / 1000)
    : 0;

  const priorStatus = call.status;
  const participants = call.participants ?? [];
  const unanswered = !wasAnswered(call);

  await db.update(chatCalls).set({
    status: unanswered && (priorStatus === 'ringing' || priorStatus === 'active') ? 'missed' : 'ended',
    endedAt: now,
    duration,
    updatedAt: now,
  }).where(eq(chatCalls.id, callId));

  // Kick everyone, end the RTK meeting, clean up the KV mapping (all best effort)
  if (call.cfAppId) {
    await teardownRtkMeeting(env, call.cfAppId, { callId });
  }

  // Post system message
  const msgId = generateId('msg');
  const endedLabel = duration > 0 ? `Call ended — ${formatDuration(duration)}` : 'Call ended';
  const content = unanswered ? 'Missed call' : endedLabel;
  await db.insert(chatMessages).values({
    id: msgId,
    channelId: call.channelId,
    authorId: call.initiatorId,
    authorName: call.initiatorName,
    content,
    type: 'system',
    createdAt: now,
    updatedAt: now,
  });

  await db.update(chatCalls).set({ endMessageId: msgId }).where(eq(chatCalls.id, callId));

  await Promise.all([
    publishChatCallEnded(env, call.channelId, { callId, duration, endedBy }).catch((e) =>
      console.error('[CallLifecycle] publishChatCallEnded failed:', e),
    ),
    broadcastChatCallToMembers(env, db, orgId, call.channelId, 'ended', { callId }).catch((e) =>
      console.error('[CallLifecycle] broadcastChatCallToMembers failed:', e),
    ),
  ]);

  // Missed-call push for unanswered DM rings (timeout / caller hangup before answer).
  // Decline already sends its own missed notification — that path does not call endChatCall.
  const shouldMissed = options?.sendMissedIfUnanswered !== false && unanswered;
  if (shouldMissed) {
    await notifyMissedDmCall(db, env, orgId, callId, call);
  }
}

// ============================================================================
// End call, but only when the room is empty
// ============================================================================

/**
 * - `ended`: RealtimeKit reported an empty room and the call was ended.
 * - `occupied`: someone is still connected, nothing was touched.
 * - `unknown`: RealtimeKit could not be asked, nothing was touched.
 */
export type EndIfEmptyOutcome = 'ended' | 'occupied' | 'unknown';

export interface EndIfEmptyOptions {
  sendMissedIfUnanswered?: boolean;
  /**
   * Also end when exactly one connection is left in the room. For a call that
   * looks unanswered, or abandoned by everyone but one person: the caller
   * still waiting in the room (start-and-join puts them there before anyone is
   * rung) must not keep it alive. A second connection means two people are
   * talking, whatever our list says.
   */
  endWhenAlone?: boolean;
}

/**
 * End a call that LOOKS finished, after asking RealtimeKit whether anyone is
 * still in the room. Every automatic end goes through here: the last
 * participant leaving, the one-call-at-a-time eviction, the stale-call sweeps,
 * the ring timeout and the `meeting.ended` webhook.
 *
 * Ending kicks everyone, so it must never be decided from `participants`
 * alone. That list drifts: a leave webhook for a dropped connection lands
 * after the SDK reconnected the same person, a second tab closes, a join's
 * write is lost. Acting on it ended live calls for everybody in them.
 * RealtimeKit knows who is connected; while it reports anyone, the call stays.
 * When the room really is empty RealtimeKit ends its own session about a
 * minute later and sends `meeting.ended`, which arrives here again and ends
 * ours. A call nobody has connected to yet (rung, never joined) has no
 * RealtimeKit session, which counts as empty.
 *
 * Not for an explicit hang-up-for-all or a decline: that is {@link endChatCall}.
 */
export async function endChatCallIfEmpty(
  db: Database,
  env: CallLifecycleEnv,
  orgId: string,
  callId: string,
  call: Parameters<typeof endChatCall>[4],
  endedBy: string,
  options?: EndIfEmptyOptions,
): Promise<EndIfEmptyOutcome> {
  if (call.cfAppId) {
    let live: number;
    try {
      live = await getLiveParticipantCount(env, call.cfAppId);
    } catch (err) {
      console.error('[CallLifecycle] RTK live participant check failed, keeping the call', {
        callId,
        cfAppId: call.cfAppId,
        err,
      });
      return 'unknown';
    }
    if (live > (options?.endWhenAlone ? 1 : 0)) return 'occupied';
  }

  await endChatCall(db, env, orgId, callId, call, endedBy, {
    sendMissedIfUnanswered: options?.sendMissedIfUnanswered,
  });
  return 'ended';
}

/** Fan a missed-call notification out to the other members of a DM channel. */
async function notifyMissedDmCall(
  db: Database,
  env: CallLifecycleEnv,
  orgId: string,
  callId: string,
  call: { channelId: string; initiatorId: string; initiatorName: string; callType?: string },
): Promise<void> {
  const { chatChannels, chatChannelMembers } = schema;
  try {
    const [channel] = await db
      .select({ type: chatChannels.type })
      .from(chatChannels)
      .where(eq(chatChannels.id, call.channelId))
      .limit(1);
    if (channel?.type !== 'dm') return;
    const members = await db
      .select({ userId: chatChannelMembers.userId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.channelId, call.channelId));
    const callType = call.callType ?? 'voice';
    await Promise.all(
      members
        .filter((m) => m.userId !== call.initiatorId)
        .map((m) =>
          sendMissedCallNotification({
            db,
            env,
            workspaceId: orgId,
            recipientUserId: m.userId,
            callerUserId: call.initiatorId,
            callerName: call.initiatorName,
            channelId: call.channelId,
            callId,
            callType,
          }).catch((e) => console.error('[CallLifecycle] Missed-call notification failed:', e)),
        ),
    );
  } catch (e) {
    console.error('[CallLifecycle] Missed-call fan-out failed:', e);
  }
}

/**
 * After a DM call starts, wait RING_TIMEOUT_MS then auto-end if still unanswered
 * so killed-app callees get a missed-call push without waiting for a poll.
 */
export function scheduleRingTimeout(
  waitUntil: (promise: Promise<unknown>) => void,
  db: Database,
  env: CallLifecycleEnv,
  orgId: string,
  callId: string,
): void {
  waitUntil(
    (async () => {
      try {
        // Cloudflare Workers: scheduler.wait keeps the waitUntil alive across the delay.
        const wait = (globalThis as unknown as { scheduler?: { wait: (ms: number) => Promise<void> } })
          .scheduler?.wait;
        if (wait) {
          await wait(RING_TIMEOUT_MS);
        } else {
          await new Promise((r) => setTimeout(r, RING_TIMEOUT_MS));
        }

        const [fresh] = await db
          .select()
          .from(schema.chatCalls)
          .where(eq(schema.chatCalls.id, callId))
          .limit(1);
        if (!fresh) return;
        if (fresh.status !== 'ringing' && fresh.status !== 'active') return;

        const participants: ChatCallParticipant[] = fresh.participants ?? [];
        const remoteJoined = participants.some(
          (p) => p.userId !== fresh.initiatorId && p.joinedAt && !p.leftAt,
        );
        if (remoteJoined) return;

        // Still only the initiator (or empty) after the ring window — treat as missed.
        if (fresh.status === 'ringing' || participants.filter((p) => !p.leftAt).length <= 1) {
          // The caller is waiting in the room, so one connection is expected.
          // A second one is the callee: they answered and our list missed it.
          const outcome = await endChatCallIfEmpty(db, env, orgId, callId, fresh, fresh.initiatorId, {
            endWhenAlone: true,
          });
          // RealtimeKit could not be asked. An unanswered call that never ends
          // swallows the next call in the DM and never sends its missed-call
          // push, and the list is rarely wrong this early, so fall back to it.
          if (outcome === 'unknown') {
            await endChatCall(db, env, orgId, callId, fresh, fresh.initiatorId);
          }
        }
      } catch (e) {
        console.error('[CallLifecycle] Ring timeout handler failed:', e);
      }
    })(),
  );
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
