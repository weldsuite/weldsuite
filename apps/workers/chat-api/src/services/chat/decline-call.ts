/**
 * Decline a ringing WeldChat call. Shared by `POST /api/chat-calls/:id/decline`
 * (the app, with a session) and `POST /public/chat-calls/decline` (the phone's
 * lock-screen / CallKit Decline button, with the ring's signed token).
 */

import { eq } from 'drizzle-orm';
import { sendMissedCallNotification } from '@weldsuite/notifications';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  cancelCallRings,
  dmCallRecipients,
  teardownRtkMeeting,
  wasAnswered,
} from '@weldsuite/chat-domain/call-lifecycle';
import {
  publishChatCallEnded,
  broadcastChatCallToMembers,
} from '@weldsuite/chat-domain/realtime/weldchat-call-publisher';
import type { Env } from '../../types';

type ChatCallRow = typeof schema.chatCalls.$inferSelect;

/** start-and-join (what both clients use) creates the call as 'active' with
 *  the caller already in it, so an unanswered 'active' call is still ringing. */
export function isRinging(call: ChatCallRow): boolean {
  return call.status === 'ringing' || (call.status === 'active' && !wasAnswered(call));
}

/**
 * End the ringing call as declined: kick the caller out, post "Missed call",
 * publish the end, stop the ring on every callee's phones and send the
 * decliner their missed-call entry. Returns false when the call was not
 * ringing (already answered or over), in which case nothing changed.
 */
export async function declineRingingCall(
  db: Database,
  env: Env,
  orgId: string,
  call: ChatCallRow,
  declinerId: string,
): Promise<boolean> {
  if (!isRinging(call)) return false;
  const { chatCalls, chatMessages } = schema;
  const callId = call.id;

  const now = new Date();
  await db.update(chatCalls).set({
    status: 'declined',
    endedAt: now,
    updatedAt: now,
  }).where(eq(chatCalls.id, callId));

  // Kick the caller out of the room, end the RTK meeting, drop the KV mapping
  if (call.cfAppId) {
    await teardownRtkMeeting(env, call.cfAppId, { callId, orgId, channelId: call.channelId, endedAt: now });
  }

  const msgId = generateId('msg');
  await db.insert(chatMessages).values({
    id: msgId,
    channelId: call.channelId,
    authorId: call.initiatorId,
    authorName: call.initiatorName,
    content: 'Missed call',
    type: 'system',
    createdAt: now,
    updatedAt: now,
  });

  try {
    await publishChatCallEnded(env, call.channelId, { callId, duration: 0, endedBy: declinerId });
    await broadcastChatCallToMembers(env, db, orgId, call.channelId, 'ended', { callId });
  } catch (e) {
    console.error('[Chat:Calls] Realtime publish failed:', e);
  }

  // The decline ends the call for everyone it rang (a group DM too), and the
  // decliner's other phones are still ringing.
  await cancelCallRings(db, env, callId, await dmCallRecipients(db, call), 'declined');

  // Send missed-call notification to the recipient (they got called but declined)
  if (declinerId !== call.initiatorId) {
    try {
      const [initiatorInfo] = await db
        .select({ name: schema.workspaceMembers.name })
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.userId, call.initiatorId))
        .limit(1);
      await sendMissedCallNotification({
        db,
        env,
        workspaceId: orgId,
        recipientUserId: declinerId,
        callerUserId: call.initiatorId,
        callerName: initiatorInfo?.name ?? call.initiatorName,
        channelId: call.channelId,
        callId,
        callType: call.callType,
      });
    } catch (e) {
      console.error('[Chat:Calls] Missed-call notification failed:', e);
    }
  }

  return true;
}
