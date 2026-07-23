/**
 * WeldDesk (v1 helpdesk) realtime publisher helpers.
 *
 * Ported from api-worker `src/services/realtime/helpdesk-publisher.ts`
 * (W5b legacy-worker phase-out). Only the functions the app-api conversation
 * surface publishes are carried over — the workspace/agent-inbox fan-out
 * (publishNewConversation / publishInbox*) is driven by the widget + inbound
 * workers, which still own those call sites.
 *
 * Every helper no-ops when the REALTIME binding is absent (local dev), matching
 * the app-api convention in weldchat-publisher.ts. The legacy versions did a
 * non-null assertion on env.REALTIME and threw instead.
 */

import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Env } from '../../types';

function getPublisher(env: Env): RealtimePublisher | null {
  return env.REALTIME ? new RealtimePublisher(env.REALTIME) : null;
}

export interface RealtimeMessageAttachment {
  id?: string;
  name?: string;
  fileName?: string;
  url?: string;
  type?: string;
  mimeType?: string;
  size?: number;
  fileSize?: number;
}

export interface RealtimeMessage {
  id: string;
  conversationId: string;
  content: string;
  senderId?: string;
  senderName?: string;
  senderType?: string;
  attachments?: RealtimeMessageAttachment[];
}

export interface AgentAssigned {
  conversationId: string;
  agentId: string;
  agentName: string;
  agentAvatar?: string;
  assignedAt: string;
}

export interface ConversationClosed {
  conversationId: string;
  closedBy?: string;
  closedByType?: string;
  closedByName?: string;
  closedAt: string;
  reason?: string;
  resolution?: string;
}

/** Publish a new message to a conversation via the ConversationRoom DO. */
export async function publishMessage(
  env: Env,
  conversationId: string,
  message: RealtimeMessage,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.conversationMessage(conversationId, {
    id: message.id,
    content: message.content,
    senderId: message.senderId || '',
    senderName: message.senderName || '',
    senderType: message.senderType || 'agent',
    attachments: message.attachments?.map((a) => ({
      id: a.id ?? message.id,
      name: a.name || a.fileName || '',
      url: a.url || '',
      type: a.type || a.mimeType || '',
      size: a.size ?? a.fileSize ?? 0,
    })),
  });
}

/** Publish an agent-assignment system event to a conversation. */
export async function publishAgentAssigned(
  env: Env,
  conversationId: string,
  assignment: AgentAssigned,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.conversationSystem(conversationId, 'agent_assigned', {
    agentId: assignment.agentId,
    agentName: assignment.agentName,
    agentAvatar: assignment.agentAvatar,
    assignedAt: assignment.assignedAt,
  });
}

/** Publish a conversation-closed system event. */
export async function publishConversationClosed(
  env: Env,
  conversationId: string,
  closed: ConversationClosed,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.conversationSystem(conversationId, 'conversation_closed', {
    closedBy: closed.closedBy,
    closedByType: closed.closedByType,
    closedByName: closed.closedByName,
    closedAt: closed.closedAt,
    reason: closed.reason,
    resolution: closed.resolution,
  });
}

/** Publish a conversation-reopened system event. */
export async function publishConversationReopened(
  env: Env,
  conversationId: string,
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.conversationSystem(conversationId, 'conversation_reopened', {
    reopenedAt: new Date().toISOString(),
  });
}

/** Publish a message:updated event (e.g. block responses landing). */
export async function publishMessageUpdated(
  env: Env,
  conversationId: string,
  data: { messageId: string; [key: string]: unknown },
): Promise<void> {
  const rt = getPublisher(env);
  if (!rt) return;
  await rt.conversationSystem(conversationId, 'message_updated', data);
}
