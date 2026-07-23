import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../../lib/workflow-shared';

export const createTicketHandler: StepHandler = {
  type: 'create_ticket_from_conversation',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;

    const [conversation] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conversationId))
      .limit(1);

    if (!conversation) return { success: false, error: 'Conversation not found' };

    // Promote conversation to ticket (same record, flagged with isTicket + ticketNumber)
    const ticketNumber = `T-${Date.now().toString(36).toUpperCase()}`;

    await db
      .update(schema.helpdeskConversations)
      .set({
        isTicket: true,
        ticketNumber,
        priority: String(ctx.inputs.priority || conversation.priority || 'medium'),
        category: String(ctx.inputs.category || conversation.category || ''),
        updatedAt: new Date(),
      })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    return { success: true, ticketNumber, conversationId };
  },
};
