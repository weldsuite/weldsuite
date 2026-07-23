import type { StepHandler, StepContext, StepResult } from '../../types';
import { evaluateCondition } from '../../lib/workflow-shared';

export const conditionHandler: StepHandler = {
  type: 'condition',

  async execute(ctx: StepContext): Promise<StepResult> {
    const condition = (ctx.inputs.field && ctx.inputs.operator)
      ? ctx.inputs
      : (ctx.stepDef.condition as Record<string, unknown>) || {};

    const field = String(condition.field || '');
    const operator = String(condition.operator || '');
    const value = condition.value;

    if (!field || !operator) {
      return { success: false, error: 'Condition missing field or operator' };
    }

    // Resolve the actual field value for tracking
    let fieldValue: unknown;
    if (field.startsWith('steps.')) {
      const [, stepId, ...rest] = field.split('.');
      const out = ctx.state.stepResults[stepId] as Record<string, unknown>;
      fieldValue = rest.reduce(
        (o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        out,
      );
    } else if (field.startsWith('trigger.')) {
      fieldValue = field.slice(8).split('.').reduce(
        (o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        ctx.state.triggerData,
      );
    } else if (field.startsWith('variables.')) {
      fieldValue = ctx.state.variables[field.slice(10)];
    }

    const met = evaluateCondition(
      { field, operator, value },
      ctx.state.stepResults,
      ctx.state.triggerData,
      ctx.state.variables,
      {}, // contactData — not available in step context
    );

    return {
      success: true,
      branch: met ? 'true' : 'false',
      field,
      operator,
      evaluatedValue: fieldValue,
    };
  },
};
