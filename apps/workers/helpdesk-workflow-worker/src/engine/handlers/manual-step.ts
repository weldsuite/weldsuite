import type { StepHandler, StepContext, StepResult } from '../../types';
import { createBotMessage } from '../helpers';
import { publishToRealtimeChannel } from '../../lib/realtime-publisher';

export const manualStepHandler: StepHandler = {
  type: 'manual_step',

  async execute(ctx: StepContext): Promise<StepResult> {
    const instruction = String(ctx.inputs.instruction || 'Manual action required');
    const assigneeId = ctx.inputs.assigneeId ? String(ctx.inputs.assigneeId) : undefined;

    // Create an internal note with the instruction
    const messageId = await createBotMessage(ctx.options.db, {
      conversationId: ctx.state.conversationId,
      content: instruction,
      authorType: 'system',
      authorId: 'workflow',
      authorName: 'System',
      isInternal: true,
      isPublic: false,
      metadata: {
        interactiveType: 'manual_step',
        workflowExecutionId: ctx.state.executionId,
        workflowStepId: ctx.stepDef.id,
        source: 'workflow',
        ...(assigneeId ? { assigneeId } : {}),
      },
    });

    // Publish notification to workspace channel so agents see the manual task
    await publishToRealtimeChannel(
      ctx.options.env,
      `workspace:${ctx.options.workspaceId}`,
      'workflow:manual_step',
      {
        conversationId: ctx.state.conversationId,
        executionId: ctx.state.executionId,
        stepId: ctx.stepDef.id,
        instruction,
        assigneeId,
        messageId,
        timestamp: new Date().toISOString(),
      },
    );

    return {
      success: true,
      __waitingForInput: true,
      instruction,
      assigneeId,
      messageId,
    };
  },
};
