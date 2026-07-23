/**
 * Shared helpers for step handlers.
 * Ported from helpdesk-workflow-worker/src/engine/helpers.ts.
 */

import { eq, sql } from 'drizzle-orm';
import { schema } from '../db';
import { generateId } from '../lib/id';
import type { Database } from '../db';

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

export async function createBotMessage(db: Database, params: CreateMessageParams): Promise<string> {
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

export async function touchConversation(db: Database, conversationId: string): Promise<void> {
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
