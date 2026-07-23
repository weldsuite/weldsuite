/**
 * Workflow Engine Helpers
 *
 * Shared utilities used by step handlers. Eliminates the duplicated
 * message insertion and @weldsuite/realtime publishing patterns.
 */

import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';
import { publishMessageToConversation } from '../lib/realtime-publisher';
import type { Env, RealtimePublishMessage } from '../types';

// ============================================================================
// Message Creation
// ============================================================================

interface CreateMessageParams {
  conversationId: string;
  content: string;
  authorId?: string;
  authorName?: string;
  authorType?: string;
  type?: string;
  isPublic?: boolean;
  isInternal?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Insert a bot/system message into the conversation.
 * Returns the generated message ID.
 */
export async function createBotMessage(
  db: Database,
  params: CreateMessageParams,
): Promise<string> {
  const messageId = generateId('msg');
  const now = new Date();

  await db.insert(schema.helpdeskConversationMessages).values({
    id: messageId,
    conversationId: params.conversationId,
    content: params.content,
    authorType: params.authorType || 'agent',
    authorId: params.authorId || 'workflow',
    authorName: params.authorName || 'Bot',
    type: params.type || 'message',
    isPublic: params.isPublic ?? true,
    isInternal: params.isInternal ?? false,
    status: 'sent',
    isRead: false,
    metadata: params.metadata,
    createdAt: now,
    updatedAt: now,
  });

  return messageId;
}

// ============================================================================
// Realtime Publishing
// ============================================================================

/**
 * Publish a message to the @weldsuite/realtime conversation channel.
 * Used during resume (when there's no SSE stream).
 */
export async function publishToRealtime(
  env: Env,
  msg: RealtimePublishMessage,
): Promise<void> {
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

// ============================================================================
// Conversation Helpers
// ============================================================================

/**
 * Update conversation last message timestamps.
 */
export async function touchConversation(
  db: Database,
  conversationId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(schema.helpdeskConversations)
    .set({
      lastMessageAt: now,
      lastAgentMessageAt: now,
      messageCount: sql`${schema.helpdeskConversations.messageCount} + 1`,
      updatedAt: now,
    })
    .where(eq(schema.helpdeskConversations.id, conversationId));
}
