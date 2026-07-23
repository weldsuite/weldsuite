import type { StepHandler, StepContext, StepResult } from '../types';
import { eq } from 'drizzle-orm';
import { schema } from '../../db';
import { resolveConversationId } from '../workflow-shared';
import { generateId } from '../../lib/id';

export const triggerCsatHandler: StepHandler = {
  type: 'trigger_csat',
  async execute(ctx: StepContext): Promise<StepResult> {
    const conversationId = resolveConversationId(ctx.inputs, ctx.state.triggerData) || ctx.state.conversationId;
    const { db } = ctx.options;

    let customerId = 'unknown';
    const [conv] = await db.select({ contactId: schema.helpdeskConversations.contactId })
      .from(schema.helpdeskConversations).where(eq(schema.helpdeskConversations.id, conversationId)).limit(1);
    if (conv?.contactId) customerId = conv.contactId;

    const surveyId = generateId('csat');
    await db.insert(schema.helpdeskSatisfactionSurveys).values({
      id: surveyId, ticketId: conversationId, customerId, status: 'pending',
      sentAt: new Date(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(), updatedAt: new Date(),
    });
    return { success: true, surveyId, conversationId };
  },
};
