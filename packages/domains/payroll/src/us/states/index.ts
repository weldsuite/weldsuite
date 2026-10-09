/**
 * US state modules. v1 covers the nine states without a wage tax plus CA,
 * NY, IL, PA, GA, NC, NJ, MA, AZ and CO (docs/plans/weldhr-payroll.md).
 *
 * Every module withholds for the work state only; a different residence
 * state raises `residence_state_differs`. Local taxes (NYC, Yonkers, PA
 * EIT/LST, …) are out of scope.
 *
 * Payslip label keys: state income tax `us.state_income_tax.<ST>`, employer
 * SUI `us.state_sui_employer.<ST>`, employee SUI `us.state_sui_employee.<ST>`
 * (helpers below); programs carry their own `labelKey`
 * (`us.state_program.<code>`). All are in STATE_PAYSLIP_LABELS.
 */

import { AK_MODULE } from './ak';
import { AZ_MODULE } from './az';
import { CA_MODULE } from './ca';
import { CO_MODULE } from './co';
import { FL_MODULE } from './fl';
import { GA_MODULE } from './ga';
import { IL_MODULE } from './il';
import { MA_MODULE } from './ma';
import { NC_MODULE } from './nc';
import { NH_MODULE } from './nh';
import { NJ_MODULE } from './nj';
import { NV_MODULE } from './nv';
import { NY_MODULE } from './ny';
import { PA_MODULE } from './pa';
import { SD_MODULE } from './sd';
import { TN_MODULE } from './tn';
import { TX_MODULE } from './tx';
import { WA_MODULE } from './wa';
import { WY_MODULE } from './wy';
import type { StateModule } from './types';

export type { StateCalcInput, StateCalcResult, StateModule, StateProgramResult, StateCertificateFieldDef } from './types';

const MODULES: Record<string, StateModule> = Object.fromEntries(
  [
    AK_MODULE, AZ_MODULE, CA_MODULE, CO_MODULE, FL_MODULE, GA_MODULE, IL_MODULE, MA_MODULE, NC_MODULE, NH_MODULE,
    NJ_MODULE, NV_MODULE, NY_MODULE, PA_MODULE, SD_MODULE, TN_MODULE, TX_MODULE, WA_MODULE, WY_MODULE,
  ].map((m) => [m.code, m]),
);

/** Two-letter codes WeldSuite can run payroll for, sorted. */
export const SUPPORTED_STATES: readonly string[] = Object.keys(MODULES).sort();

export function stateModule(code: string | null | undefined): StateModule | undefined {
  return code ? MODULES[code.toUpperCase()] : undefined;
}

/**
 * Certificate fields that are answers of the election itself
 * (`UsStateCertificateInput.filingStatus`, `.allowances`, `.extraWithholding`,
 * `.exempt`) rather than entries of its `values`. A certificate's `fields` list
 * the whole form in order; a form renders each field once and binds these keys
 * to the top-level properties.
 */
export const CERTIFICATE_TOP_LEVEL_KEYS = ['filingStatus', 'allowances', 'extraWithholding', 'exempt'] as const;

export type CertificateTopLevelKey = (typeof CERTIFICATE_TOP_LEVEL_KEYS)[number];

export function isCertificateTopLevelKey(key: string): key is CertificateTopLevelKey {
  return (CERTIFICATE_TOP_LEVEL_KEYS as readonly string[]).includes(key);
}

/** Payslip label key of the state income tax line. */
export function stateIncomeTaxLabelKey(state: string): string {
  return `us.state_income_tax.${state.toUpperCase()}`;
}

/** Payslip label key of the employer SUI line. */
export function stateSuiEmployerLabelKey(state: string): string {
  return `us.state_sui_employer.${state.toUpperCase()}`;
}

/** Payslip label key of the employee SUI line (AK, NJ, PA). */
export function stateSuiEmployeeLabelKey(state: string): string {
  return `us.state_sui_employee.${state.toUpperCase()}`;
}
