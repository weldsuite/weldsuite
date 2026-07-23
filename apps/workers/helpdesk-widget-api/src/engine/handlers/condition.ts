import type { StepHandler, StepContext, StepResult } from '../types';
import { evaluateCondition } from '../workflow-shared';

export const conditionHandler: StepHandler = {
  type: 'condition',
  async execute(ctx: StepContext): Promise<StepResult> {
    const condition = (ctx.inputs.field && ctx.inputs.operator) ? ctx.inputs : (ctx.stepDef.condition as Record<string, unknown>) || {};
    const field = String(condition.field || '');
    const operator = String(condition.operator || '');
    if (!field || !operator) return { success: false, error: 'Condition missing field or operator' };

    const met = evaluateCondition({ field, operator, value: condition.value }, ctx.state.stepResults, ctx.state.triggerData, ctx.state.variables, {});
    return { success: true, branch: met ? 'true' : 'false', field, operator };
  },
};
