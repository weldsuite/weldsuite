/**
 * States without a wage income tax: the module computes SUI (with any
 * employee share and employer surcharges) and the state's payroll programs.
 *
 * UI wages follow FUTA wages (`FICA_LIKE`): 401(k) deferrals count, Section
 * 125, HSA and dependent care salary reductions do not. Each state's UI law
 * pulls in FUTA wages; none of these states publishes a deviation for
 * cafeteria plans that we found.
 */

import type { PayrollIssue } from '../../types';
import {
  FICA_LIKE,
  YtdWriter,
  computeSui,
  provisionalIssue,
  residenceIssue,
  unsupportedYearResult,
  type SuiRules,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule, StateProgramResult } from './types';

export interface NoIncomeTaxStateDef {
  code: string;
  name: string;
  /** Rule set name, e.g. `us-fl-2026.1`. */
  ruleSet: string;
  /** SUI rules for this input (some depend on whether the employer entered its own rate). */
  sui: (input: StateCalcInput) => Omit<SuiRules, 'exclusions'>;
  /** Unverified rule items that apply to this input; non-empty → `provisional_rules`. */
  provisional?: (input: StateCalcInput) => string[];
  programs?: (input: StateCalcInput, ytd: YtdWriter) => { programs: StateProgramResult[]; issues: PayrollIssue[] };
  certificate?: StateModule['certificate'];
  employerRateCodes?: StateModule['employerRateCodes'];
}

export function noIncomeTaxModule(def: NoIncomeTaxStateDef): StateModule {
  const calculate = (input: StateCalcInput): StateCalcResult => {
    if (input.taxYear !== 2026) return unsupportedYearResult(input, def.code);
    const ytd = new YtdWriter(input, def.code);
    const issues: PayrollIssue[] = [...residenceIssue(input, def.code), ...provisionalIssue(def.code, def.provisional?.(input) ?? [])];
    const sui = computeSui(input, def.code, { ...def.sui(input), exclusions: FICA_LIKE }, ytd);
    issues.push(...sui.issues);
    const extra = def.programs?.(input, ytd) ?? { programs: [], issues: [] };
    issues.push(...extra.issues);
    return {
      stateWagesCents: 0,
      incomeTaxCents: 0,
      sui: sui.sui,
      programs: [...extra.programs, ...sui.programs],
      ytdUpdates: ytd.updates,
      issues,
      ruleSet: def.ruleSet,
    };
  };
  return {
    code: def.code,
    name: def.name,
    hasIncomeTax: false,
    supportedYears: [2026],
    certificate: def.certificate ?? null,
    ...(def.employerRateCodes ? { employerRateCodes: def.employerRateCodes } : {}),
    calculate,
  };
}
