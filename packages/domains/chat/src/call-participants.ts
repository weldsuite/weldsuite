/**
 * WeldChat — call participant invariants.
 *
 * Two rules that must NEVER be violated, enforced server-side so they hold
 * regardless of client (two browser tabs, web + mobile, a stale reconnect):
 *
 *   1. A user appears at most ONCE in a call's participant list. Every write
 *      goes through `upsertParticipant`, which is idempotent on `userId` and
 *      surfaces the user's previous live RTK session(s) so the caller can evict
 *      them (kills the "two of me" duplicate tile).
 *
 *   2. A user is in at most ONE call at a time (like Discord). Before adding a
 *      user to a call, `leaveOtherActiveCalls` removes them from every other
 *      ringing/active call: evicts the live RTK session (their old call window
 *      drops via `roomLeft`), marks them left, and ends any call that is now
 *      empty, once RealtimeKit confirms nobody is connected to it. The same
 *      rule spans WeldMeet: joining a meeting session also leaves chat calls
 *      (`leaveOtherActiveCalls` is called from meet-api) and joining a chat call
 *      also leaves meeting sessions (`leaveOtherMeetingSessions` in
 *      `@weldsuite/meet-domain/leave-other-sessions`, called from chat-api).
 *
 * Eviction is always a LEAVE, never an END for everyone: a call only ends
 * through `endChatCallIfEmpty`, which asks RealtimeKit first.
 *
 * The `participants` column is a denormalised JSONB array, so uniqueness can't
 * be a DB constraint — these helpers are the single chokepoint that keeps it
 * consistent. Route handlers must not hand-roll participant merges.
 *
 * Lives in a package because meet-api (joining a meeting leaves chat calls)
 * and chat-api both run it (docs/plans/app-api-module-split.md).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { removeParticipant, type CloudflareRealtimeEnv } from '@weldsuite/cloudflare-realtime';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import {
  publishChatCallParticipantLeft,
  publishChatCallSuperseded,
  type WeldChatCallPublisherEnv,
} from './realtime/weldchat-call-publisher';
import {
  endChatCallIfEmpty,
  RING_TIMEOUT_MS,
  wasAnswered,
  type CallLifecycleEnv,
} from './call-lifecycle';

/** A ringing/active call older than this with nobody left in it is dead. */
const STALE_CALL_MS = 60_000;

/**
 * Whether an existing ringing/active call blocks a new call in its channel, or
 * is dead and should be ended so the new call can start (and ring).
 *
 * Starting a call where one is already live joins it instead, which never
 * rings anyone. That is right for a live call, but in a DM a leftover call
 * (a leave that never reached us, a ring timeout that never fired) would
 * otherwise swallow every later call: the caller sits alone in the old room
 * and the other person gets no ring and no push. So in a DM a call is
 * abandoned when nobody but the requester is still in it, or when nobody
 * answered it within the ring window.
 */
export function isAbandonedCall(
  call: {
    status: string;
    createdAt: Date | string;
    initiatorId: string;
    participants: ChatCallParticipant[] | null | undefined;
  },
  opts: { isDm: boolean; requesterId: string; now?: number },
): boolean {
  const age = (opts.now ?? Date.now()) - new Date(call.createdAt).getTime();
  const active = dedupeParticipants(call.participants).filter((p) => !p.leftAt);

  if (active.length === 0 && age > STALE_CALL_MS) return true;
  if (call.status === 'ringing' && age > STALE_CALL_MS) return true;
  if (!opts.isDm) return false;

  if (active.every((p) => p.userId === opts.requesterId)) return true;
  return !wasAnswered(call) && age > RING_TIMEOUT_MS;
}

/**
 * When two entries exist for the same user, keep the better one: an active
 * (not-left) entry beats a left one; otherwise the most recently joined.
 */
function pickBetter(a: ChatCallParticipant, b: ChatCallParticipant): ChatCallParticipant {
  const aActive = !a.leftAt;
  const bActive = !b.leftAt;
  if (aActive !== bActive) return aActive ? a : b;
  const at = new Date(a.joinedAt).getTime();
  const bt = new Date(b.joinedAt).getTime();
  return bt >= at ? b : a;
}

/**
 * Collapse a participants array so every `userId` appears at most once.
 * Used on every read and write so a duplicate can never reach a client even
 * if a legacy row already contains one.
 */
export function dedupeParticipants(
  participants: ChatCallParticipant[] | null | undefined,
): ChatCallParticipant[] {
  const byUser = new Map<string, ChatCallParticipant>();
  for (const p of participants ?? []) {
    const existing = byUser.get(p.userId);
    byUser.set(p.userId, existing ? pickBetter(existing, p) : p);
  }
  return [...byUser.values()];
}

/** Count of distinct users currently active (not left) in a call. */
export function activeParticipantCount(
  participants: ChatCallParticipant[] | null | undefined,
): number {
  return dedupeParticipants(participants).filter((p) => !p.leftAt).length;
}

/**
 * Replace any existing entries for `participant.userId` with the fresh one,
 * guaranteeing the user appears exactly once. Returns the new (deduped) list
 * plus the live RTK session ids of the user's previous *active* entries, so the
 * caller can evict those stale sessions and avoid a duplicate "me" tile.
 */
export function upsertParticipant(
  participants: ChatCallParticipant[] | null | undefined,
  participant: ChatCallParticipant,
): { next: ChatCallParticipant[]; staleSessionIds: string[] } {
  const staleSessionIds: string[] = [];
  const next: ChatCallParticipant[] = [];
  for (const p of dedupeParticipants(participants)) {
    if (p.userId === participant.userId) {
      if (!p.leftAt && p.cfSessionId && p.cfSessionId !== participant.cfSessionId) {
        staleSessionIds.push(p.cfSessionId);
      }
      continue; // dropped — replaced by the fresh entry below
    }
    next.push(p);
  }
  next.push(participant);
  return { next, staleSessionIds };
}

/**
 * Evict a set of live RTK sessions from a meeting. Best-effort, never throws.
 *
 * With `notify`, each evicted session is first announced to the user as a
 * `call_superseded` event, so the tab that is about to lose its room knows why
 * (it joined this call again elsewhere) instead of seeing a bare disconnect.
 * Every id here is a session that was just REPLACED, never the one just created.
 */
export async function evictRtkSessions(
  env: CloudflareRealtimeEnv & WeldChatCallPublisherEnv,
  cfAppId: string | null | undefined,
  sessionIds: string[],
  notify?: { orgId: string; userId: string; callId: string },
): Promise<void> {
  if (!cfAppId || sessionIds.length === 0) return;
  await Promise.all(
    sessionIds.map(async (sid) => {
      if (notify) {
        await publishChatCallSuperseded(env, notify.orgId, notify.userId, {
          kind: 'chat',
          id: notify.callId,
          cfSessionId: sid,
        }).catch(() => {
          /* best effort */
        });
      }
      await removeParticipant(env, cfAppId, sid).catch(() => {
        /* session may already be gone — best effort */
      });
    }),
  );
}

/** Options of {@link leaveOtherActiveCalls}. */
export interface LeaveOtherCallsOptions {
  /**
   * When the join that triggers this eviction started (ms since epoch; default:
   * now, at the moment of the call). A participation that began AFTER it is
   * left alone: it is a newer join elsewhere racing this one, and the delayed
   * eviction must not kick it.
   */
  triggeredAt?: number;
}

/**
 * Discord-style "one call at a time": remove `userId` from every *other*
 * ringing/active call they are still in. For each such call it tells the user's
 * clients (`call_superseded`), evicts the live RTK session (the old call window
 * drops via `roomLeft`), marks the participant left, publishes participant-left,
 * and ends the call if nobody active remains and RealtimeKit agrees: our list
 * alone never ends a call, it can be missing someone who is still talking (see
 * endChatCallIfEmpty).
 *
 * Calls are found through the user's entry in `chat_calls.participants` rather
 * than their channel memberships, so a call in a public channel the user joined
 * without being a member is found too.
 *
 * Best-effort and self-contained — logs and swallows its own errors so it can
 * be fired from a `waitUntil` without risking the join response.
 */
export async function leaveOtherActiveCalls(
  db: Database,
  env: CallLifecycleEnv,
  orgId: string,
  userId: string,
  exceptCallId: string | null,
  opts: LeaveOtherCallsOptions = {},
): Promise<void> {
  const triggeredAt = opts.triggeredAt ?? Date.now();
  const { chatCalls } = schema;
  try {
    const calls = await db
      .select()
      .from(chatCalls)
      .where(
        and(
          inArray(chatCalls.status, ['ringing', 'active']),
          sql`${chatCalls.participants} @> ${JSON.stringify([{ userId }])}::jsonb`,
        ),
      );

    for (const call of calls) {
      if (call.id === exceptCallId) continue;
      try {
        await leaveCall(db, env, orgId, userId, call, triggeredAt);
      } catch (e) {
        console.error('[Chat:Calls] leaveOtherActiveCalls failed for call', { callId: call.id, e });
      }
    }
  } catch (e) {
    console.error('[Chat:Calls] leaveOtherActiveCalls failed:', e);
  }
}

/** Drop `userId` from one call: announce, evict the RTK session, mark left, end if empty. */
async function leaveCall(
  db: Database,
  env: CallLifecycleEnv,
  orgId: string,
  userId: string,
  call: typeof schema.chatCalls.$inferSelect,
  triggeredAt: number,
): Promise<void> {
  const deduped = dedupeParticipants(call.participants);
  const mine = deduped.find((p) => p.userId === userId && !p.leftAt);
  if (!mine) return; // not actually in this call
  const joinedAt = Date.parse(mine.joinedAt);
  if (!Number.isNaN(joinedAt) && joinedAt > triggeredAt) return; // a newer join, not the one superseded

  // Tell the user's clients why, BEFORE the room is pulled from under them.
  await publishChatCallSuperseded(env, orgId, userId, {
    kind: 'chat',
    id: call.id,
    cfSessionId: mine.cfSessionId || null,
  }).catch(() => {
    /* best effort */
  });

  // Drop the user's live session so their old call window tears down.
  await evictRtkSessions(env, call.cfAppId, mine.cfSessionId ? [mine.cfSessionId] : []);

  const now = new Date();
  const updated = deduped.map((p) =>
    p.userId === userId && !p.leftAt ? { ...p, leftAt: now.toISOString() } : p,
  );
  const stillActive = updated.filter((p) => !p.leftAt);

  await db
    .update(schema.chatCalls)
    .set({ participants: updated, updatedAt: now })
    .where(eq(schema.chatCalls.id, call.id));

  await publishChatCallParticipantLeft(env, call.channelId, {
    callId: call.id,
    userId,
  }).catch(() => {});

  if (stillActive.length === 0) {
    try {
      // Unanswered: the only connection there can be is the one evicted above.
      await endChatCallIfEmpty(db, env, orgId, call.id, call, userId, {
        endWhenAlone: !wasAnswered(call),
      });
    } catch {
      /* best effort */
    }
  }
}
