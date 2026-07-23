import type { StepHandler, StepContext, StepResult } from '../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../workflow-shared';

export const changePriorityHandler: StepHandler = {
  type: 'change_priority',
  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const priority = String(ctx.inputs.priority);
    await ctx.options.db
      .update(schema.helpdeskConversations)
      .set({ priority, updatedAt: new Date() })
      .where(eq(schema.helpdeskConversations.id, conversationId));
    return { success: true, conversationId, priority };
  },
};
