import type { StepHandler, StepContext, StepResult } from '../../types';
import { asText } from '@weldsuite/text';

export const gotoStepHandler: StepHandler = {
  type: 'goto',

  async execute(ctx: StepContext): Promise<StepResult> {
    const targetStepId = asText(ctx.inputs.targetStepId || '');

    if (!targetStepId) {
      return { success: false, error: 'goto step missing targetStepId' };
    }

    return {
      success: true,
      gotoStepId: targetStepId,
    };
  },
};
