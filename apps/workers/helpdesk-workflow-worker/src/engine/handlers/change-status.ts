import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { publishToRealtimeChannel } from '../../lib/realtime-publisher';
import { resolveConversationId } from '../../lib/workflow-shared';

export const changeStatusHandler: StepHandler = {
  type: 'change_conversation_status',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db, env, workspaceId } = ctx.options;

    const status = String(ctx.inputs.status);
    const updateData: Record<string, unknown> = { status, updatedAt: new Date() };

    if (status === 'snoozed' && ctx.inputs.snoozeDurationMinutes) {
      updateData.snoozedUntil = new Date(Date.now() + Number(ctx.inputs.snoozeDurationMinutes) * 60_000);
    }
    if (status === 'resolved') updateData.resolvedAt = new Date();
    if (status === 'closed') updateData.closedAt = new Date();

    await db
      .update(schema.helpdeskConversations)
      .set(updateData)
      .where(eq(schema.helpdeskConversations.id, conversationId));

    if (status === 'closed' || status === 'resolved') {
      // Publish system event: conversation_closed
      await publishToRealtimeChannel(env, `conversation:${conversationId}`, 'system:conversation_closed', {
        text: `Conversation ${status}`,
        conversationId,
        status,
        closedAt: new Date().toISOString(),
      }).catch(() => {});
    }

    await publishToRealtimeChannel(env, `workspace:${workspaceId}`, 'conversation:updated', {
      conversationId,
      status,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});

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

    return { success: true, conversationId, status };
  },
};
