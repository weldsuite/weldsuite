/**
 * Realtime for the WeldDesk phone queue. `workspaceId` is the Clerk org id
 * throughout (what the realtime hub keys on). `REALTIME` can be absent (tests,
 * local dev): every publish is then a no-op, and presence reads "everyone".
 *
 * Browser contract (docs on each function):
 *   topic `inbox.<userId>`  events `phone.incoming` | `phone.answered` | `phone.ended`
 *   topic `desk_phone_queue` event `updated` `{ waiting: number }`
 */

import { and, isNotNull, isNull, sql } from 'drizzle-orm';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';

export type PhoneEndedReason = 'answered_elsewhere' | 'caller_hung_up' | 'timeout';

export interface PhoneIncomingEvent {
  callId: string;
  conversationId: string | null;
  fromNumber: string;
  callerName: string | null;
  customerName: string | null;
  departmentId: string | null;
  /** ISO time the caller started waiting. */
  waitingSince: string;
}

function publisher(env: Env): RealtimePublisher | null {
  if (!env.REALTIME) return null;
  return new RealtimePublisher(env.REALTIME, { internalSecret: env.REALTIME_INTERNAL_SECRET });
}

/** Send one member an inbox event (`phone.incoming`, `phone.answered`, `phone.ended`). Never throws. */
export async function sendPhoneInboxEvent(
  env: Env,
  workspaceId: string,
  userId: string,
  event: 'phone.incoming' | 'phone.answered' | 'phone.ended',
  data: Record<string, unknown>,
): Promise<void> {
  const rt = publisher(env);
  if (!rt) return;
  try {
    await rt.inboxEvent(workspaceId, userId, event, data);
  } catch (err) {
    console.error(`[desk-phone] realtime ${event} failed:`, err);
  }
}

/** Callers waiting for an agent: queued, no agent yet, not ended, no outcome. */
export function waitingCallsCondition() {
  const c = schema.voipCalls;
  return and(isNotNull(c.queueEnteredAt), isNull(c.agentAnsweredAt), isNull(c.endedAt), isNull(c.outcome));
}

/** Tell every client the waiting set changed. Never throws. */
export async function publishPhoneQueueChange(env: Env, db: Database, workspaceId: string): Promise<void> {
  const rt = publisher(env);
  if (!rt) return;
  try {
    const [row] = await db
      .select({ waiting: sql<number>`count(*)` })
      .from(schema.voipCalls)
      .where(waitingCallsCondition());
    await rt.publish(workspaceId, 'desk_phone_queue', 'updated', { waiting: Number(row?.waiting ?? 0) }, 'system');
  } catch (err) {
    console.error('[desk-phone] realtime queue update failed:', err);
  }
}

/**
 * Which of `userIds` have a realtime connection open and read `online`.
 * Without `REALTIME`, or when presence cannot be read, everyone counts as online.
 */
export async function onlineUserIds(env: Env, workspaceId: string, userIds: string[]): Promise<Set<string>> {
  const rt = publisher(env);
  if (!rt || userIds.length === 0) return new Set(userIds);
  try {
    const presence = await rt.getPresence(workspaceId, userIds);
    return new Set(userIds.filter((id) => presence[id] === 'online'));
  } catch (err) {
    console.warn('[desk-phone] presence unavailable, treating everyone as online:', err);
    return new Set(userIds);
  }
}
