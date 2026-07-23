import type { StepHandler, StepContext, StepResult } from '../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../workflow-shared';

export const changeStatusHandler: StepHandler = {
  type: 'change_conversation_status',
  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;
    const status = String(ctx.inputs.status);
    const updateData: Record<string, unknown> = { status, updatedAt: new Date() };

    if (status === 'snoozed' && ctx.inputs.snoozeDurationMinutes) {
      updateData.snoozedUntil = new Date(Date.now() + Number(ctx.inputs.snoozeDurationMinutes) * 60_000);
    }
    if (status === 'resolved') updateData.resolvedAt = new Date();
    if (status === 'closed') updateData.closedAt = new Date();

    await db.update(schema.helpdeskConversations).set(updateData).where(eq(schema.helpdeskConversations.id, conversationId));
    return { success: true, conversationId, status };
  },
};
