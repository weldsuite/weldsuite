import type { StepHandler, StepContext, StepResult } from '../../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../../lib/workflow-shared';

export const snoozeConversationHandler: StepHandler = {
  type: 'snooze_conversation',

  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;

    const duration = Number(ctx.inputs.duration);
    const durationUnit = String(ctx.inputs.durationUnit || 'minutes') as 'minutes' | 'hours' | 'days';

    let durationMs: number;
    switch (durationUnit) {
      case 'hours':
        durationMs = duration * 60 * 60_000;
        break;
      case 'days':
        durationMs = duration * 24 * 60 * 60_000;
        break;
      case 'minutes':
      default:
        durationMs = duration * 60_000;
        break;
    }

    const now = new Date();
    const snoozedUntil = new Date(now.getTime() + durationMs);

    await db
      .update(schema.helpdeskConversations)
      .set({
        status: 'snoozed',
        snoozedUntil,
        updatedAt: now,
      })
      .where(eq(schema.helpdeskConversations.id, conversationId));

    return { success: true, conversationId, snoozedUntil: snoozedUntil.toISOString() };
  },
};
