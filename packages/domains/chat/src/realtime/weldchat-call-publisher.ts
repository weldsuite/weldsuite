/**
 * WeldChat Call Realtime Publisher.
 *
 * Ported from api-worker's services/realtime/weldchat-publisher.ts — only the
 * CALL-related publishers used by the chat-calls routes. Wraps
 * `RealtimePublisher` from @weldsuite/realtime/server (Durable Objects).
 *
 * Best-effort: when the REALTIME binding is absent (local dev) the publisher
 * is null and every helper no-ops instead of throwing. The exact `rt.*` method
 * calls + event shapes mirror the source so the platform/mobile clients see
 * the same payloads (notably `call_incoming` on `chat.user.${userId}`).
 */

import { RealtimePublisher } from '@weldsuite/realtime/server';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

/** The binding the publishers read. Any worker Env with it fits. */
export interface WeldChatCallPublisherEnv {
  /** realtime-worker service binding (Durable Objects fan-out). */
  REALTIME?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

function getPublisher(env: WeldChatCallPublisherEnv): RealtimePublisher | null {
  return env.REALTIME ? new RealtimePublisher(env.REALTIME) : null;
}

export async function publishChatCallStarted(
  env: WeldChatCallPublisherEnv,
  channelId: string,
  data: { callId: string; callType: string; initiatorId: string; initiatorName: string },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatCall(channelId, data.callId, data.initiatorId, 'started');
}

export async function publishChatCallEnded(
  env: WeldChatCallPublisherEnv,
  channelId: string,
  data: { callId: string; duration?: number; endedBy?: string },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatCall(channelId, data.callId, data.endedBy ?? '', 'ended');
}

export async function publishChatCallParticipantJoined(
  env: WeldChatCallPublisherEnv,
  channelId: string,
  data: { callId: string; userId: string; userName: string; userAvatar?: string; cfSessionId: string },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatCallParticipant(channelId, { ...data, action: 'joined' });
}

export async function publishChatCallParticipantLeft(
  env: WeldChatCallPublisherEnv,
  channelId: string,
  data: { callId: string; userId: string },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatCallParticipant(channelId, {
    ...data,
    userName: '',
    action: 'left',
  });
}

/**
 * Broadcast a call started/ended event to every member of a channel via
 * their personal `chat.user.${userId}` topic. Lets the WeldChat sidebar
 * react to call state changes across all channels with a single topic
 * subscription instead of N per-channel polls.
 */
export async function broadcastChatCallToMembers(
  env: WeldChatCallPublisherEnv,
  db: Database,
  workspaceId: string,
  channelId: string,
  action: 'started' | 'ended',
  data: { callId: string; callType?: string },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  const event = action === 'started' ? 'call_started' : 'call_ended';
  const members = await db
    .select({ userId: schema.chatChannelMembers.userId })
    .from(schema.chatChannelMembers)
    .where(eq(schema.chatChannelMembers.channelId, channelId));
  await Promise.all(
    members.map((m) =>
      rt.publish(
        workspaceId,
        `chat.user.${m.userId}`,
        event,
        { channelId, ...data },
        'system',
      ),
    ),
  );
}

export async function publishChatCallIncoming(
  env: WeldChatCallPublisherEnv,
  workspaceId: string,
  userId: string,
  data: { callId: string; channelId: string; callType: string; callerName: string; callerAvatar?: string },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatCallIncoming(workspaceId, userId, data);
}
