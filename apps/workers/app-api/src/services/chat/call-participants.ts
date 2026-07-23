/**
 * WeldChat — call participant invariants (app-api).
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
 *      empty.
 *
 * The `participants` column is a denormalised JSONB array, so uniqueness can't
 * be a DB constraint — these helpers are the single chokepoint that keeps it
 * consistent. Route handlers must not hand-roll participant merges.
 */

import { eq, and, or, inArray } from 'drizzle-orm';
import { removeParticipant } from '@weldsuite/cloudflare-realtime';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Database } from '../../db';
import { schema } from '../../db';
import type { Env } from '../../types';
import { publishChatCallParticipantLeft } from '../realtime/weldchat-call-publisher';
import { endChatCall } from './call-lifecycle';

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

/** Evict a set of live RTK sessions from a meeting. Best-effort, never throws. */
export async function evictRtkSessions(
  env: Env,
  cfAppId: string | null | undefined,
  sessionIds: string[],
): Promise<void> {
  if (!cfAppId || sessionIds.length === 0) return;
  await Promise.all(
    sessionIds.map((sid) =>
      removeParticipant(env, cfAppId, sid).catch(() => {
        /* session may already be gone — best effort */
      }),
    ),
  );
}

/**
 * Discord-style "one call at a time": remove `userId` from every *other*
 * ringing/active call they are still in. For each such call it evicts the live
 * RTK session (the old call window drops via `roomLeft`), marks the participant
 * left, publishes participant-left, and ends the call if nobody active remains.
 *
 * Best-effort and self-contained — logs and swallows its own errors so it can
 * be fired from a `waitUntil` without risking the join response.
 */
export async function leaveOtherActiveCalls(
  db: Database,
  env: Env,
  orgId: string,
  userId: string,
  exceptCallId: string | null,
): Promise<void> {
  const { chatCalls, chatChannelMembers } = schema;
  try {
    const memberships = await db
      .select({ channelId: chatChannelMembers.channelId })
      .from(chatChannelMembers)
      .where(eq(chatChannelMembers.userId, userId));

    const channelIds = memberships.map((m) => m.channelId);
    if (channelIds.length === 0) return;

    const calls = await db
      .select()
      .from(chatCalls)
      .where(
        and(
          inArray(chatCalls.channelId, channelIds),
          or(eq(chatCalls.status, 'ringing'), eq(chatCalls.status, 'active')),
        ),
      );

    for (const call of calls) {
      if (call.id === exceptCallId) continue;

      const deduped = dedupeParticipants(call.participants);
      const mine = deduped.find((p) => p.userId === userId && !p.leftAt);
      if (!mine) continue; // not actually in this call

      // Drop the user's live session so their old call window tears down.
      await evictRtkSessions(env, call.cfAppId, mine.cfSessionId ? [mine.cfSessionId] : []);

      const now = new Date();
      const updated = deduped.map((p) =>
        p.userId === userId && !p.leftAt ? { ...p, leftAt: now.toISOString() } : p,
      );
      const stillActive = updated.filter((p) => !p.leftAt);

      await db
        .update(chatCalls)
        .set({ participants: updated, updatedAt: now })
        .where(eq(chatCalls.id, call.id));

      await publishChatCallParticipantLeft(env, call.channelId, {
        callId: call.id,
        userId,
      }).catch(() => {});

      if (stillActive.length === 0) {
        try {
          await endChatCall(db, env, orgId, call.id, call, userId);
        } catch {
          /* best effort */
        }
      }
    }
  } catch (e) {
    console.error('[Chat:Calls] leaveOtherActiveCalls failed:', e);
  }
}
