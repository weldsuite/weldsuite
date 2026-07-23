import type { StepHandler, StepContext, StepResult } from '../../types';

export const delayHandler: StepHandler = {
  type: 'delay',

  async execute(ctx: StepContext): Promise<StepResult> {
    const seconds = Number(ctx.inputs.duration || ctx.inputs.delaySeconds || 1);
    const durationMs = Math.min(seconds * 1000, 30_000);

    ctx.emit({
      event: 'step:delay',
      data: { durationMs, stepId: ctx.stepDef.id },
    });

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    return { success: true, durationMs };
  },
};
