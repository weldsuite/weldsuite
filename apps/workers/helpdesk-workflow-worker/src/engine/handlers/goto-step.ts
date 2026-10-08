import type { StepHandler, StepContext, StepResult } from '../../types';
import { asText } from '@weldsuite/text';

export const gotoStepHandler: StepHandler = {
  type: 'goto',

  execute(ctx: StepContext): Promise<StepResult> {
    const targetStepId = asText(ctx.inputs.targetStepId || '');

    if (!targetStepId) {
      return Promise.resolve({ success: false, error: 'goto step missing targetStepId' });
    }

    return Promise.resolve({
      success: true,
      gotoStepId: targetStepId,
    });
  },
};
