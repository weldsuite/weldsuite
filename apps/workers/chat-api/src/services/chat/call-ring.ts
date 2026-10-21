/**
 * Stopping a call's native ring when someone answers it. Only a join that
 * answers a ring may send the cancel: on iOS every cancel is a VoIP push, and
 * a phone that is not ringing for the call has to show it to CallKit and end
 * it at once (the report-every-push rule), which flashes an incoming-call
 * screen and can leave a Recents entry.
 */

import { CALL_RING_TTL_MS, cancelIncomingCallPush, type NotificationEnv } from '@weldsuite/notifications';
import { dmCallRecipients } from '@weldsuite/chat-domain/call-lifecycle';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import type { Database } from '@weldsuite/worker-kit/db';

export interface RingedCall {
  id: string;
  channelId: string;
  initiatorId: string;
  createdAt: Date;
  participants?: ChatCallParticipant[] | null;
}

/**
 * Whether `userId` joining `call` answers a ring still going on their phones:
 * the call rang them (a DM they are in, not the caller), it is their first
 * join (not a rejoin), and their phones have not stopped ringing by themselves
 * yet. Read `call` as it was before the join was recorded.
 */
export async function joinAnswersRing(
  db: Database,
  call: RingedCall,
  userId: string,
  now = Date.now(),
): Promise<boolean> {
  if (userId === call.initiatorId) return false;
  if ((call.participants ?? []).some((p) => p.userId === userId && p.joinedAt)) return false;
  if (now - new Date(call.createdAt).getTime() > CALL_RING_TTL_MS) return false;
  return (await dmCallRecipients(db, call)).includes(userId);
}

/** A join answered the ring: stop it on the user's other phones. Never throws. */
export async function cancelRingOnAnswer(
  db: Database,
  env: NotificationEnv,
  call: RingedCall,
  userId: string,
): Promise<void> {
  try {
    if (!(await joinAnswersRing(db, call, userId))) return;
    await cancelIncomingCallPush({ db, env, userId, callId: call.id, reason: 'answered' });
  } catch (err) {
    console.error('[Chat:Calls] Ring cancel on answer failed:', err);
  }
}
