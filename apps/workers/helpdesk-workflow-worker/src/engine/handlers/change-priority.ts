import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { publishToRealtimeChannel } from '../../lib/realtime-publisher';
import { resolveConversationId } from '../../lib/workflow-shared';

export const changePriorityHandler: StepHandler = {
  type: 'change_priority',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db, env } = ctx.options;
    const priority = String(ctx.inputs.priority);

    await db
      .update(schema.helpdeskConversations)
      .set({ priority, updatedAt: new Date() })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    // Publish conversation state
    const [conv] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    if (conv) {
      const state = {
        id: conv.id,
        conversationNumber: conv.conversationNumber,
        subject: conv.subject,
        status: conv.status,
        priority: conv.priority,
        channel: conv.channel,
        customerName: conv.customerName,
        customerEmail: conv.customerEmail,
        contactId: conv.contactId,
        assigneeId: conv.assigneeId,
        assigneeName: conv.assigneeName,
        assigneeAvatar: conv.assigneeAvatar,
        departmentId: conv.departmentId,
        tags: conv.tags,
        messageCount: conv.messageCount,
        unreadCount: conv.unreadCount,
        isRead: conv.isRead,
      };

      await publishToRealtimeChannel(env, `conversation:${conversationId}`, 'system:conversation_state_changed', {
        conversationId,
        conversation: state,
      }).catch(() => {});
    }

    return { success: true, conversationId, priority };
  },
};
