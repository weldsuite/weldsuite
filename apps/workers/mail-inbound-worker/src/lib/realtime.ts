/**
 * Realtime publisher for Mail Inbound Worker
 *
 * Publishes new email notifications and helpdesk events via the
 * @weldsuite/realtime service binding (WorkspaceHub DO).
 *
 * Event naming follows underscore convention (conversation_new, message_new)
 * matching the api-worker's helpdesk-publisher.
 */

import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Env } from '../index';

function getPublisher(env: Env): RealtimePublisher {
  if (!env.REALTIME) {
    throw new Error('REALTIME service binding is not configured');
  }
  return new RealtimePublisher(env.REALTIME);
}

/**
 * Publish a new email notification to a user's mail topic.
 * → WorkspaceHub topic: mail.{userId}, event: mail:new
 */
export async function publishNewEmailToUser(
  env: Env,
  workspaceId: string,
  userId: string,
  emailData: {
    accountId: string;
    /** Stored row id (`msg_…`) — what the client fetches by. */
    messageId: string;
    /** RFC 5322 Message-ID header, for callers that key off the wire id. */
    smtpMessageId: string;
    threadId: string;
    from: { email: string; name?: string };
    subject: string;
    preview: string;
    receivedAt: string;
    isRead: boolean;
    hasAttachments: boolean;
  }
): Promise<void> {
  const rt = getPublisher(env);
  await rt.mailEvent(workspaceId, userId, 'mail:new', emailData);
}

/**
 * Publish a new email notification to a PERSONAL (consumer) account.
 *
 * Personal WeldMail users have no Clerk org, so there is no workspace hub to
 * publish into. `personalMailEvent` targets the user's own hub
 * (`personal:<clerkUserId>`) on topic `mail.<clerkUserId>` — the same topic
 * shape the workspace path uses, so clients share one subscription helper.
 */
export async function publishNewPersonalEmail(
  env: Env,
  clerkUserId: string,
  emailData: {
    accountId: string;
    messageId: string;
    smtpMessageId: string;
    threadId: string;
    from: { email: string; name?: string };
    subject: string;
    preview: string;
    receivedAt: string;
    isRead: boolean;
    hasAttachments: boolean;
  }
): Promise<void> {
  const rt = getPublisher(env);
  await rt.personalMailEvent(clerkUserId, 'mail:new', emailData);
}

/**
 * Publish a new message notification to all agents in the workspace.
 * → WorkspaceHub topic: helpdesk, event: message_new
 *
 * This is a workspace-wide broadcast (not agent-specific).
 */
export async function publishWorkspaceMessageNew(
  env: Env,
  workspaceId: string,
  data: {
    conversationId: string;
    preview: string;
    senderName: string;
    timestamp: string;
  }
): Promise<void> {
  const rt = getPublisher(env);
  await rt.helpdeskEvent(workspaceId, 'message_new', data);
}

/**
 * Publish a new helpdesk conversation event to all agents.
 * → WorkspaceHub topic: helpdesk, event: conversation_new
 */
export async function publishNewConversation(
  env: Env,
  workspaceId: string,
  data: {
    id: string;
    conversationId: string;
    conversationNumber: string;
    subject: string;
    customerName: string;
    customerEmail: string;
    preview: string;
    channel: string;
    status: string;
    createdAt: string;
    lastMessageAt: string;
  }
): Promise<void> {
  const rt = getPublisher(env);
  await rt.helpdeskEvent(workspaceId, 'conversation_new', data);
}

/**
 * Notify the WeldDesk inbox that a support email landed in desk_conversations.
 * Uses Clerk org id as the WorkspaceHub key (same as app-api).
 */
export async function publishDeskInbound(
  env: Env,
  clerkOrgId: string,
  params: {
    conversation: { id: string; [key: string]: unknown };
    message: { id: string; body?: string | null; authorId?: string | null; kind?: string | null; conversationId?: string };
    created: boolean;
    preview: string;
    senderName: string;
  },
): Promise<void> {
  const rt = getPublisher(env);
  const { conversation, message, created, preview, senderName } = params;
  await rt.publish(
    clerkOrgId,
    'desk_conversation',
    created ? 'created' : 'updated',
    conversation,
    'system',
  );
  await rt.publish(clerkOrgId, 'desk_message', 'created', message, 'system');
  await rt.conversationPublish(conversation.id, {
    type: 'message',
    id: message.id,
    content: message.body ?? preview,
    senderId: message.authorId,
    senderType: 'visitor',
    senderName,
    kind: message.kind ?? 'message',
    ts: Date.now(),
  });
}
