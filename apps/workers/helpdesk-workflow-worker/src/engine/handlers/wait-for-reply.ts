import type { StepHandler, StepContext, StepResult } from '../../types';
import { createBotMessage } from '../helpers';

export const waitForReplyHandler: StepHandler = {
  type: 'wait_for_reply',

  async execute(ctx: StepContext): Promise<StepResult> {
    const timeout = ctx.inputs.timeout ? Number(ctx.inputs.timeout) : undefined;
    const content = String(ctx.inputs.message || "We'll be right with you");

    const messageId = await createBotMessage(ctx.options.db, {
      conversationId: ctx.state.conversationId,
      content,
      metadata: {
        interactiveType: 'wait_for_reply',
        workflowExecutionId: ctx.state.executionId,
        workflowStepId: ctx.stepDef.id,
        source: 'workflow',
        ...(timeout !== undefined ? { timeoutMinutes: timeout } : {}),
      },
    });

    const now = new Date().toISOString();

    ctx.emit({
      event: 'step:message',
      data: {
        id: messageId,
        content: 'Waiting for customer reply...',
        authorName: 'Bot',
        authorType: 'agent',
        createdAt: now,
      },
    });

    await ctx.publish({
      id: messageId,
      conversationId: ctx.state.conversationId,
      content,
      senderId: 'workflow',
      senderName: 'Bot',
      senderType: 'agent',
      timestamp: now,
      metadata: { interactiveType: 'wait_for_reply' },
    });

    return {
      success: true,
      __waitingForInput: true,
      messageId,
    };
  },
};
