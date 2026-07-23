/**
 * WeldChat — End Call lifecycle (app-api).
 *
 * Ported from api-worker's services/meeting-lifecycle.ts (WeldChat section).
 * Context-free function for ending a chat call: marks the row ended, ends the
 * Cloudflare RealtimeKit meeting, cleans up the KV mapping, posts the
 * "Call ended" system message, and publishes the realtime events.
 */

import { eq } from 'drizzle-orm';
import { endMeeting as endRtkMeeting } from '@weldsuite/cloudflare-realtime';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Env } from '../../types';
import { publishChatCallEnded, broadcastChatCallToMembers } from '../realtime/weldchat-call-publisher';

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
  },
  endedBy: string,
): Promise<void> {
  const { chatCalls, chatMessages } = schema;

  const now = new Date();
  const duration = call.startedAt
    ? Math.round((now.getTime() - new Date(call.startedAt).getTime()) / 1000)
    : 0;

  await db.update(chatCalls).set({
    status: 'ended',
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
  const durationText = duration > 0 ? formatDuration(duration) : '';
  await db.insert(chatMessages).values({
    id: msgId,
    channelId: call.channelId,
    authorId: call.initiatorId,
    authorName: call.initiatorName,
    content: `Call ended${durationText ? ` — ${durationText}` : ''}`,
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
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
