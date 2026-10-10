/**
 * The `weldhr-payroll` feature flag gates every payroll route (the back
 * office, My HR and the workforce portal): a workspace without it gets a 404,
 * as if the endpoints did not exist. `weldhr-payroll-digipoort` additionally
 * gates sending the loonaangifte over Digipoort.
 */

import { createMiddleware } from 'hono/factory';
import { featureFlagsMiddleware } from '@weldsuite/worker-kit/middleware/feature-flags';
import { error } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../../types';
import type { HrContext } from '../helpers';

type FlagKey = 'weldhr-payroll' | 'weldhr-payroll-digipoort';

/**
 * The request's flag evaluator. Authenticated routes get it from `apiAuth()`;
 * the portal has no auth chain, so evaluate it here (same evaluator, the
 * workspace comes from the slug middleware).
 */
async function flagsOf(c: HrContext) {
  let flags = c.get('flags');
  if (!flags) {
    await featureFlagsMiddleware()(c as never, async () => undefined);
    flags = c.get('flags');
  }
  return flags;
}

export async function flagOn(c: HrContext, key: FlagKey): Promise<boolean> {
  const flags = await flagsOf(c);
  return flags ? flags.isOn(key) : false;
}

export const requirePayrollFlag = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  if (!(await flagOn(c, 'weldhr-payroll'))) return error.notFound(c, 'Payroll');
  await next();
});
