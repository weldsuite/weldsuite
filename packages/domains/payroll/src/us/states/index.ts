/**
 * US state modules. v1 covers the nine states without a wage tax plus CA,
 * NY, IL, PA, GA, NC, NJ, MA, AZ and CO (docs/plans/weldhr-payroll.md).
 * Placeholder until the modules land.
 */

import type { StateModule } from './types';

export type { StateCalcInput, StateCalcResult, StateModule, StateProgramResult, StateCertificateFieldDef } from './types';

const MODULES: Record<string, StateModule> = {};

/** Two-letter codes WeldSuite can run payroll for. */
export const SUPPORTED_STATES: readonly string[] = Object.keys(MODULES);

export function stateModule(code: string | null | undefined): StateModule | undefined {
  return code ? MODULES[code.toUpperCase()] : undefined;
}
