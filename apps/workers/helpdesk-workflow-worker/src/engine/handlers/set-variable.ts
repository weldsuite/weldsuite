import type { StepHandler, StepContext, StepResult } from '../../types';
import { asText } from '@weldsuite/text';

export const setVariableHandler: StepHandler = {
  type: 'set_variable',

  async execute(ctx: StepContext): Promise<StepResult> {
    ctx.state.variables[asText(ctx.inputs.name || '')] = ctx.inputs.value;
    return { success: true };
  },
};
