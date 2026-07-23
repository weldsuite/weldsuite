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
    messageId: string;
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
