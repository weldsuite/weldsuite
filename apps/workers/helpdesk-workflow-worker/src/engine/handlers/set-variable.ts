import type { StepHandler, StepContext, StepResult } from '../../types';

export const setVariableHandler: StepHandler = {
  type: 'set_variable',

  async execute(ctx: StepContext): Promise<StepResult> {
    ctx.state.variables[String(ctx.inputs.name || '')] = ctx.inputs.value;
    return { success: true };
  },
};
