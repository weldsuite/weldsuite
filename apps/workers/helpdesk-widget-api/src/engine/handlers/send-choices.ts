import type { StepHandler, StepContext, StepResult } from '../types';
import { createBotMessage } from '../helpers';

export const sendChoicesHandler: StepHandler = {
  type: 'send_choices',
  async execute(ctx: StepContext): Promise<StepResult> {
    const content = String(ctx.inputs.message || '');
    const rawOptions = (ctx.inputs.options as Array<{ id?: string; label: string; value: string }>) || [];
    const choiceOptions = rawOptions.map((o) => ({ id: o.id || `opt_${o.value}`, label: o.label, value: o.value }));

    const messageId = await createBotMessage(ctx.options.db, {
      conversationId: ctx.state.conversationId,
      content,
      metadata: {
        interactiveType: 'choices',
        workflowExecutionId: ctx.state.executionId,
        workflowStepId: ctx.stepDef.id,
        options: choiceOptions,
        source: 'workflow',
      },
    });

    await ctx.publish({
      id: messageId,
      conversationId: ctx.state.conversationId,
      content,
      senderId: 'workflow',
      senderName: 'Bot',
      senderType: 'agent',
      timestamp: new Date().toISOString(),
      metadata: { interactiveType: 'choices', options: choiceOptions },
    });

    return { __waitingForInput: true, success: true, messageId, conversationId: ctx.state.conversationId };
  },
};
