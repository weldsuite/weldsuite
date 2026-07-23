import type { StepHandler, StepContext, StepResult } from '../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../workflow-shared';

export const unassignConversationHandler: StepHandler = {
  type: 'unassign_conversation',
  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    await ctx.options.db.update(schema.helpdeskConversations)
      .set({ assigneeId: null, assigneeName: null, assigneeAvatar: null, updatedAt: new Date() })
      .where(eq(schema.helpdeskConversations.id, conversationId));
    return { success: true, conversationId };
  },
};
