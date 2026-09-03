/**
 * WeldChat — End Call lifecycle (app-api).
 *
 * Ported from api-worker's services/meeting-lifecycle.ts (WeldChat section).
 * Context-free function for ending a chat call: marks the row ended, ends the
 * Cloudflare RealtimeKit meeting, cleans up the KV mapping, posts the
 * "Call ended" system message, and publishes the realtime events.
 *
 * When an unanswered DM call ends (nobody but the initiator joined, or it was
 * still ringing), also delivers `chat_missed_call` push to other members so a
 * killed-app callee gets a "missed call" after ring timeout / caller hangup.
 */

import { eq } from 'drizzle-orm';
import { endMeeting as endRtkMeeting } from '@weldsuite/cloudflare-realtime';
import { sendMissedCallNotification } from '@weldsuite/notifications';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Env } from '../../types';
import { publishChatCallEnded, broadcastChatCallToMembers } from '../realtime/weldchat-call-publisher';

const RING_TIMEOUT_MS = 60_000;

export async function endChatCall(
  db: Database,
  env: Env,
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
  const { chatCalls, chatMessages, chatChannels, chatChannelMembers } = schema;

  const now = new Date();
  const duration = call.startedAt
    ? Math.round((now.getTime() - new Date(call.startedAt).getTime()) / 1000)
    : 0;

  const priorStatus = call.status;
  const participants = call.participants ?? [];
  const everJoinedRemote = participants.some(
    (p) => p.userId !== call.initiatorId && !!p.joinedAt,
  );
  const unanswered = !everJoinedRemote;

  await db.update(chatCalls).set({
    status: unanswered && (priorStatus === 'ringing' || priorStatus === 'active') ? 'missed' : 'ended',
    endedAt: now,
    duration,
    updatedAt: now,
  }).where(eq(chatCalls.id, callId));

  // End RTK meeting
  if (call.cfAppId) {
    try { await endRtkMeeting(env, call.cfAppId); } catch { /* best effort */ }
  }

  // Clean up KV mapping
  if (call.cfAppId) {
    await env.WORKSPACE_CACHE.delete(`rtk-meeting:${call.cfAppId}`).catch(() => {});
  }

  // Post system message
  const msgId = generateId('msg');
  const content =
    unanswered
      ? 'Missed call'
      : `Call ended${duration > 0 ? ` — ${formatDuration(duration)}` : ''}`;
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
    try {
      const [channel] = await db
        .select({ type: chatChannels.type })
        .from(chatChannels)
        .where(eq(chatChannels.id, call.channelId))
        .limit(1);
      if (channel?.type === 'dm') {
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
      }
    } catch (e) {
      console.error('[CallLifecycle] Missed-call fan-out failed:', e);
    }
  }
}

/**
 * After a DM call starts, wait RING_TIMEOUT_MS then auto-end if still unanswered
 * so killed-app callees get a missed-call push without waiting for a poll.
 */
export function scheduleRingTimeout(
  waitUntil: (promise: Promise<unknown>) => void,
  db: Database,
  env: Env,
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
          await endChatCall(db, env, orgId, callId, fresh, fresh.initiatorId);
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
