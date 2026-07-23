import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../../lib/workflow-shared';

export const applySlaHandler: StepHandler = {
  type: 'apply_sla',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;

    const slaId = String(ctx.inputs.slaId || '');
    if (!slaId) return { success: false, error: 'No SLA ID specified' };

    if (conversationId) {
      await db
        .update(schema.helpdeskConversations)
        .set({ slaId, slaStatus: 'active', updatedAt: new Date() })
        .where(eq(schema.helpdeskConversations.id, conversationId));

      return { success: true, conversationId, slaId };
    }

    return { success: false, error: 'No conversation found' };
  },
};
