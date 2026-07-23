import type { StepHandler, StepContext, StepResult } from '../types';

export const delayHandler: StepHandler = {
  type: 'delay',
  async execute(ctx: StepContext): Promise<StepResult> {
    const seconds = Number(ctx.inputs.duration || ctx.inputs.delaySeconds || 1);
    const durationMs = Math.min(seconds * 1000, 5_000); // Cap at 5s for inline execution
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return { success: true, durationMs };
  },
};
