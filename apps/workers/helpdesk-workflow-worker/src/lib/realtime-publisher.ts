/**
 * Realtime Publishing Utilities
 *
 * Publishes messages and events to the realtime-worker via service binding.
 */

import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { Env, RealtimePublishMessage, WorkflowStateSnapshot } from '../types';

/**
 * Publish a message to a conversation via ConversationRoom DO.
 */
export async function publishMessageToConversation(
  env: Env,
  conversationId: string,
  message: {
    id: string;
    content: string;
    senderId: string;
    senderName: string;
    senderType: 'agent' | 'system' | 'customer';
    timestamp: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!env.REALTIME) return;
  const rt = new RealtimePublisher(env.REALTIME);
  await rt.conversationMessage(conversationId, {
    id: message.id,
    content: message.content,
    senderId: message.senderId,
    senderName: message.senderName,
    senderType: message.senderType,
  });
}

/**
 * Publish a system event to a conversation via ConversationRoom DO.
 */
export async function publishToRealtimeChannel(
  env: Env,
  channelName: string,
  eventName: string,
  data: unknown,
): Promise<void> {
  if (!env.REALTIME) return;
  const rt = new RealtimePublisher(env.REALTIME);

  // Parse channel name to determine target
  if (channelName.startsWith('conversation:')) {
    const conversationId = channelName.replace('conversation:', '');
    await rt.conversationSystem(conversationId, eventName, data);
  } else if (channelName.startsWith('workspace:')) {
    const workspaceId = channelName.replace('workspace:', '');
    await rt.helpdeskEvent(workspaceId, eventName, data);
  } else if (channelName.startsWith('workflow:')) {
    const conversationId = channelName.replace('workflow:', '');
    await rt.conversationSystem(conversationId, eventName, data);
  }
}

/**
 * Publish new conversation event to workspace channel.
 */
export async function publishNewConversation(
  env: Env,
  workspaceId: string,
  conversation: Record<string, unknown>,
): Promise<void> {
  if (!env.REALTIME) return;
  const rt = new RealtimePublisher(env.REALTIME);
  await rt.helpdeskEvent(workspaceId, 'conversation_new', conversation);
}

/**
 * Publish workflow state snapshot for real-time agent UI.
 */
export async function publishWorkflowState(
  env: Env,
  conversationId: string,
  snapshot: WorkflowStateSnapshot,
): Promise<void> {
  if (!env.REALTIME) return;
  const rt = new RealtimePublisher(env.REALTIME);
  await rt.conversationSystem(conversationId, 'workflow_state', snapshot);
}

/**
 * Helper: build a message and publish via ConversationRoom DO.
 */
export async function publishToRealtime(env: Env, msg: RealtimePublishMessage): Promise<void> {
  await publishMessageToConversation(env, msg.conversationId, {
    id: msg.id,
    content: msg.content,
    senderId: msg.senderId,
    senderName: msg.senderName,
    senderType: msg.senderType,
    timestamp: msg.timestamp,
    metadata: msg.metadata,
  });
}
