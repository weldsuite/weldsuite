import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../../lib/workflow-shared';

export const closeConversationHandler: StepHandler = {
  type: 'close_conversation',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;

    const now = new Date();

    await db
      .update(schema.helpdeskConversations)
      .set({
        status: 'closed',
        closedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    return { success: true, conversationId };
  },
};
