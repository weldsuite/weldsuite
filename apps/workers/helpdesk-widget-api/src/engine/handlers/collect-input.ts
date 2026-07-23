import type { StepHandler, StepContext, StepResult } from '../types';
import { createBotMessage } from '../helpers';

export const collectInputHandler: StepHandler = {
  type: 'collect_input',
  async execute(ctx: StepContext): Promise<StepResult> {
    const content = String(ctx.inputs.message || '');
    const fields = (ctx.inputs.fields as Array<{ id: string; label: string; type: string; required: boolean; placeholder?: string }>) || [];

    const messageId = await createBotMessage(ctx.options.db, {
      conversationId: ctx.state.conversationId,
      content,
      metadata: {
        interactiveType: 'collect_input',
        workflowExecutionId: ctx.state.executionId,
        workflowStepId: ctx.stepDef.id,
        fields,
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
      metadata: { interactiveType: 'collect_input', fields },
    });

    return { __waitingForInput: true, success: true, messageId, conversationId: ctx.state.conversationId };
  },
};
