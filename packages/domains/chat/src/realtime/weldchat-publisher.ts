/**
 * WeldChat realtime publisher helpers — membership + clips subset.
 *
 * Ported from api-worker `src/services/realtime/weldchat-publisher.ts` (W3
 * legacy-worker phase-out). Only the functions consumed by the app-api ports
 * (invitations accept flow, chat clips) are carried over; message/reaction/
 * call publishing already lives in `services/chat/post-message.ts` and
 * `services/realtime/weldchat-call-publisher.ts`.
 *
 * All helpers no-op when the REALTIME binding is absent (local dev), matching
 * the app-api convention in weldchat-call-publisher.ts.
 */

import { RealtimePublisher } from '@weldsuite/realtime/server';

/** The binding the publishers read. Any worker Env with it fits. */
export interface WeldChatPublisherEnv {
  /** realtime-worker service binding (Durable Objects fan-out). */
  REALTIME?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

function getPublisher(env: WeldChatPublisherEnv): RealtimePublisher | null {
  return env.REALTIME ? new RealtimePublisher(env.REALTIME) : null;
}

export interface ChatMemberEventPayload {
  channelId: string;
  userId: string;
  userName?: string;
}

/** Notify a channel (ChatRoom DO) that a member joined. */
export async function publishChatMemberJoined(
  env: WeldChatPublisherEnv,
  channelId: string,
  data: ChatMemberEventPayload,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatMember(channelId, data.userId, data.userName ?? '', 'joined');
}

/** Notify a channel (ChatRoom DO) that a member left (or was removed). */
export async function publishChatMemberLeft(
  env: WeldChatPublisherEnv,
  channelId: string,
  data: ChatMemberEventPayload,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatMember(channelId, data.userId, data.userName ?? '', 'left');
}

/** Broadcast a channel-level change (fields updated, roster changed, deleted). */
export async function publishChatChannelUpdated(
  env: WeldChatPublisherEnv,
  channelId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatChannelUpdated(channelId, data);
}

/** Notify a user's other devices (WorkspaceHub DO) that their unread changed. */
export async function publishChatUnreadUpdate(
  env: WeldChatPublisherEnv,
  workspaceId: string,
  userId: string,
  channelId: string,
  unreadCount: number,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatUserUnreadUpdate(workspaceId, userId, { channelId, unreadCount });
}

/** Broadcast a read receipt to the channel (drives the "seen by" avatars). */
export async function publishChatReadUpdated(
  env: WeldChatPublisherEnv,
  channelId: string,
  data: {
    channelId: string;
    userId: string;
    userName: string;
    userAvatar?: string;
    lastReadMessageId: string;
    lastReadAt: string;
  },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatReadUpdated(channelId, data);
}

/** Notify a user (WorkspaceHub DO) that a new channel appeared in their sidebar. */
export async function publishChatUserChannelNew(
  env: WeldChatPublisherEnv,
  workspaceId: string,
  userId: string,
  channelId: string,
  channelName: string,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatUserChannelNew(workspaceId, userId, { channelId, channelName });
}

/** Broadcast a clip transcript status/content change to the channel. */
export async function publishChatClipTranscriptUpdated(
  env: WeldChatPublisherEnv,
  channelId: string,
  data: { messageId: string; attachmentId: string; transcript: Record<string, unknown> },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatClipTranscriptUpdated(channelId, data);
}

/** Broadcast that a message was pinned in a channel. */
export async function publishChatMessagePinned(
  env: WeldChatPublisherEnv,
  channelId: string,
  messageId: string,
  pinnedBy: string,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatPin(channelId, messageId, pinnedBy, 'pinned');
}

/** Broadcast that a message was unpinned (manually or by pin expiry). */
export async function publishChatMessageUnpinned(
  env: WeldChatPublisherEnv,
  channelId: string,
  messageId: string,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatPin(channelId, messageId, '', 'unpinned');
}

/** Broadcast a message content edit to the ChatRoom DO. */
export async function publishChatMessageUpdated(
  env: WeldChatPublisherEnv,
  channelId: string,
  data: { id: string; [key: string]: unknown },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatMessageUpdated(channelId, data);
}

/** Broadcast a message soft-delete to the ChatRoom DO. */
export async function publishChatMessageDeleted(
  env: WeldChatPublisherEnv,
  channelId: string,
  messageId: string,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.chatMessageDeleted(channelId, messageId);
}
