/**
 * WeldMeet Chat Realtime Publisher (app-api)
 *
 * Publishes meeting chat messages via @weldsuite/realtime ChatRoom DO.
 * Uses room key `meet_{meetingId}` to avoid collision with WeldChat channels.
 *
 * Ported from apps/api-worker/src/services/realtime/weldmeet-chat-publisher.ts.
 */

import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Env } from '../../types';

export interface MeetingChatMessagePayload {
  id: string;
  meetingId: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  htmlContent?: string;
  type: string;
  attachments?: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
  }>;
  createdAt: string;
}

function getPublisher(env: Env): RealtimePublisher | null {
  if (!env.REALTIME) {
    console.warn(
      '[weldmeet-chat] REALTIME service binding is undefined — meeting chat will not fan out. Check wrangler.toml [[services]] configuration.',
    );
    return null;
  }
  return new RealtimePublisher(env.REALTIME);
}

export async function publishMeetingChatMessage(
  env: Env,
  meetingId: string,
  message: MeetingChatMessagePayload,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  const topic = `meet_${meetingId}`;
  try {
    await rt.chatMessage(topic, {
      id: message.id,
      content: message.content,
      htmlContent: message.htmlContent,
      senderId: message.authorId,
      senderName: message.authorName,
      senderAvatar: message.authorAvatar,
      attachments: message.attachments?.map((a) => ({
        id: a.id,
        name: a.fileName,
        url: a.url,
        type: a.mimeType,
        size: a.fileSize,
      })),
    });
  } catch (err) {
    console.error(`[weldmeet-chat] publishMeetingChatMessage failed: meetingId=${meetingId} topic=${topic}`, err);
    throw err;
  }
}

export async function publishMeetingChatMessageDeleted(
  env: Env,
  meetingId: string,
  messageId: string,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  const topic = `meet_${meetingId}`;
  try {
    await rt.chatMessageDeleted(topic, messageId);
  } catch (err) {
    console.error(`[weldmeet-chat] publishMeetingChatMessageDeleted failed: meetingId=${meetingId} topic=${topic} messageId=${messageId}`, err);
    throw err;
  }
}
