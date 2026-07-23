import type { StepHandler, StepContext, StepResult } from '../../types';

export const gotoStepHandler: StepHandler = {
  type: 'goto',

  async execute(ctx: StepContext): Promise<StepResult> {
    const targetStepId = String(ctx.inputs.targetStepId || '');

    if (!targetStepId) {
      return { success: false, error: 'goto step missing targetStepId' };
    }

    return {
      success: true,
      gotoStepId: targetStepId,
    };
  },
};
