import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { publishMessageToConversation } from '../../lib/realtime-publisher';
import { resolveConversationId } from '../../lib/workflow-shared';
import { generateId } from '../../lib/id';

export const sendReplyHandler: StepHandler = {
  type: 'send_reply',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db, env } = ctx.options;
    const messageId = generateId('msg');
    const authorType = String(ctx.inputs.authorType || 'system');
    const content = String(ctx.inputs.message || '');
    const now = new Date();

    await db.insert(schema.helpdeskConversationMessages).values({
      id: messageId,
      conversationId,
      content,
      authorType,
      authorId: authorType === 'agent' ? 'system' : 'system',
      authorName: authorType === 'agent' ? 'Agent' : 'System',
      type: 'message',
      isPublic: true,
      status: 'sent',
      createdAt: now,
      updatedAt: now,
    });

    await db
      .update(schema.helpdeskConversations)
      .set({ lastMessageAt: now, lastAgentMessageAt: now, updatedAt: now })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    await publishMessageToConversation(env, conversationId, {
      id: messageId,
      content,
      senderId: 'system',
      senderName: authorType === 'agent' ? 'Agent' : 'System',
      senderType: authorType === 'agent' ? 'agent' : ('system' as any),
      timestamp: now.toISOString(),
    }).catch(() => {});

    return { success: true, messageId, conversationId };
  },
};
