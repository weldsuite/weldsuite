import type { StepHandler, StepContext, StepResult } from '../types';
import { createBotMessage } from '../helpers';

export const sendMessageHandler: StepHandler = {
  type: 'send_message',
  async execute(ctx: StepContext): Promise<StepResult> {
    const content = String(ctx.inputs.message || '');
    if (!content) return { success: true, skipped: true };

    const messageId = await createBotMessage(ctx.options.db, {
      conversationId: ctx.state.conversationId,
      content,
      metadata: { workflowId: ctx.state.workflowId, source: 'workflow', isBot: true },
    });

    await ctx.publish({
      id: messageId,
      conversationId: ctx.state.conversationId,
      content,
      senderId: 'workflow',
      senderName: 'Bot',
      senderType: 'agent',
      timestamp: new Date().toISOString(),
    });

    return { success: true, messageId, conversationId: ctx.state.conversationId, content };
  },
};
