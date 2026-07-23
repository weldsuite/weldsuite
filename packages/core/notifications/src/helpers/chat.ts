/**
 * WeldChat + missed-call notification helpers. Plain-text email for now —
 * each can opt into a Resend template later by passing `emailTemplate` to
 * `createAndDeliverNotification`.
 */

import { createAndDeliverNotification } from '../orchestrator';
import type { Database, NotificationEnv } from '../types';

interface ChatMentionParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  mentionedUserId: string;
  authorUserId: string;
  authorName: string;
  channelId: string;
  messageId: string;
  preview: string;
}

export async function sendChatMentionNotification<Env extends NotificationEnv>(
  params: ChatMentionParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, mentionedUserId, authorUserId, authorName, channelId, messageId, preview } = params;
  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: mentionedUserId,
    title: `${authorName} mentioned you`,
    body: preview,
    category: 'weldchat',
    notificationType: 'chat_mention',
    entityType: 'chat_message',
    entityId: messageId,
    actionUrl: `/weldchat/${channelId}?messageId=${messageId}`,
    severity: 'info',
    actorType: 'user',
    actorId: authorUserId,
  });
}

interface ChatThreadReplyParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  recipientUserId: string;
  authorUserId: string;
  authorName: string;
  channelId: string;
  parentMessageId: string;
  replyMessageId: string;
  preview: string;
}

export async function sendChatThreadReplyNotification<Env extends NotificationEnv>(
  params: ChatThreadReplyParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, recipientUserId, authorUserId, authorName, channelId, parentMessageId, replyMessageId, preview } = params;
  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: recipientUserId,
    title: `${authorName} replied to a thread`,
    body: preview,
    category: 'weldchat',
    notificationType: 'chat_thread_reply',
    entityType: 'chat_message',
    entityId: replyMessageId,
    actionUrl: `/weldchat/${channelId}?messageId=${parentMessageId}`,
    severity: 'info',
    actorType: 'user',
    actorId: authorUserId,
  });
}

interface ChatDmParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  recipientUserId: string;
  senderUserId: string;
  senderName: string;
  channelId: string;
  preview: string;
}

export async function sendChatDmNotification<Env extends NotificationEnv>(
  params: ChatDmParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, recipientUserId, senderUserId, senderName, channelId, preview } = params;
  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: recipientUserId,
    title: `New message from ${senderName}`,
    body: preview || 'Sent you a direct message',
    category: 'weldchat',
    notificationType: 'chat_dm',
    entityType: 'chat_channel',
    entityId: channelId,
    actionUrl: `/weldchat/dm/${channelId}`,
    severity: 'info',
    actorType: 'user',
    actorId: senderUserId,
  });
}

interface MissedCallParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  recipientUserId: string;
  callerUserId: string;
  callerName: string;
  channelId: string;
  callId: string;
  callType: string;
}

export async function sendMissedCallNotification<Env extends NotificationEnv>(
  params: MissedCallParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, recipientUserId, callerUserId, callerName, channelId, callId, callType } = params;
  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: recipientUserId,
    title: `Missed ${callType} call from ${callerName}`,
    body: 'Tap to call back',
    category: 'weldchat',
    notificationType: 'chat_missed_call',
    entityType: 'chat_call',
    entityId: callId,
    actionUrl: `/weldchat/dm/${channelId}`,
    severity: 'info',
    actorType: 'user',
    actorId: callerUserId,
    // A call is a real-time event — deliver only in-app + push (the mobile
    // ring/banner), never email. An emailed "missed call" is pure noise.
    excludeChannels: ['email'],
  });
}

interface IncomingCallParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  workspaceId: string;
  recipientUserId: string;
  callerUserId: string;
  callerName: string;
  channelId: string;
  callId: string;
  callType: string;
}

export async function sendIncomingCallNotification<Env extends NotificationEnv>(
  params: IncomingCallParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, recipientUserId, callerUserId, callerName, channelId, callId, callType } = params;
  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: recipientUserId,
    title: `Incoming ${callType} call from ${callerName}`,
    body: 'Tap to answer',
    category: 'weldchat',
    notificationType: 'chat_incoming_call',
    entityType: 'chat_call',
    entityId: callId,
    actionUrl: `/weldchat/dm/${channelId}`,
    severity: 'info',
    actorType: 'user',
    actorId: callerUserId,
    // An incoming call rings via push (mobile) + the realtime `call_incoming`
    // event (in-app banner). Email is pointless for a live ring and is the
    // "you are being called" mail users complained about — never send it.
    excludeChannels: ['email'],
  });
}
