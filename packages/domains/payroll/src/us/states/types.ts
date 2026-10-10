/**
 * The contract between the US federal engine (us/calculate.ts) and the state
 * modules (us/states/<st>.ts).
 *
 * The federal engine works out gross pay, pre-tax deductions and federal
 * taxes, then asks the state module of the work state for everything
 * state-level: income tax withholding, unemployment insurance (SUI), and the
 * payroll-funded disability / paid-leave programs (CA SDI, NY PFL+DBL, NJ
 * TDI/FLI, MA PFML, CO FAMLI, WA PFML + WA Cares, …). States without a wage
 * tax still have a module: SUI and their programs live there.
 *
 * A state module decides its own taxable wage from the breakdown it gets,
 * because states differ on which pre-tax deductions reduce state wages
 * (e.g. Pennsylvania taxes 401(k) deferrals, New Jersey taxes Section 125
 * health premiums only in part).
 */

import type { Cents } from '../../money';
import type { PayrollIssue, UsStateCertificateInput, UsW4Input } from '../../types';

export interface StateCalcInput {
  state: string;
  taxYear: number;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  /** 52, 26, 24 or 12. */
  periodsPerYear: number;
  /** Gross wages this period, split by withholding method. */
  regularWagesCents: Cents;
  /** Bonuses, commissions and other supplemental wages. */
  supplementalWagesCents: Cents;
  /** Pre-tax deductions this period. */
  pretax: {
    retirement401kCents: Cents;
    section125Cents: Cents;
    hsaCents: Cents;
    dependentCareCents: Cents;
  };
  /** The employee's certificate for this state; null when none was signed. */
  certificate: UsStateCertificateInput | null;
  /** Some states read the federal W-4 (e.g. Colorado's formula without a state form). */
  federalW4: UsW4Input | null;
  /** Employer SUI rate for this state and year (percent); null = not entered. */
  suiRatePercent: number | null;
  /** Other employer rates for this state (percent), keyed by the module's rate code. */
  extraRates: Record<string, number>;
  /** Employees on the employer's payroll (size rules for PFML programs). */
  employeeCountEstimate: number | null;
  /** Year-to-date accumulators (all keys; the module reads its own `us.state.<ST>.*` keys). */
  ytd: Record<string, Cents>;
  /** Residence state, for reciprocity and resident-only taxes. */
  residenceState: string | null;
  exemptFromSui: boolean;
  /**
   * Employee Social Security + Medicare (including Additional Medicare) withheld
   * this period. Massachusetts subtracts it from wages for withholding, up to
   * $2,000 a year (Circular M). Optional: when absent, the MA module estimates
   * 7.65% of FICA wages (none when the employee is FICA-exempt, which the
   * federal engine signals by passing 0).
   */
  ficaEmployeeCents?: Cents;
}

export interface StateProgramResult {
  /** e.g. `ca_sdi`, `ny_pfl`, `ny_dbl`, `nj_tdi`, `nj_fli`, `ma_pfml`, `co_famli`, `wa_pfml`, `wa_cares`. */
  code: string;
  /** Payslip label key (see us/labels.ts). */
  labelKey: string;
  wagesCents: Cents;
  employeeCents: Cents;
  employerCents: Cents;
}

export interface StateCalcResult {
  /** State taxable wages for income tax (0 for states without a wage tax). */
  stateWagesCents: Cents;
  incomeTaxCents: Cents;
  sui: {
    /** Wages subject to SUI this period (after the wage base). */
    taxableWagesCents: Cents;
    /** All wages counted for SUI reporting this period. */
    grossWagesCents: Cents;
    employerCents: Cents;
    /** AK, NJ, PA take an employee share. */
    employeeCents: Cents;
  };
  programs: StateProgramResult[];
  /** New values for this module's `us.state.<ST>.*` accumulators (this period added). */
  ytdUpdates: Record<string, Cents>;
  issues: PayrollIssue[];
  /** e.g. `us-ca-2026.1` */
  ruleSet: string;
}

/**
 * One field of a state withholding certificate. The keys `filingStatus`,
 * `allowances`, `extraWithholding` (money per pay period) and `exempt` map to
 * the same-named properties of `UsStateCertificateInput`; every other key is
 * stored in its `values`. Select options are labelled
 * `<state>.<key>.<option>` in STATE_CERTIFICATE_LABELS, and `<state>.form`
 * names the form.
 */
export interface StateCertificateFieldDef {
  key: string;
  type: 'select' | 'number' | 'money' | 'boolean';
  /** For `select`. */
  options?: string[];
  required?: boolean;
  /** Translation key for the label, under `weldhr.payroll.stateCertificates.<state>.<key>`. */
  labelKey: string;
}

export interface StateModule {
  code: string;
  name: string;
  hasIncomeTax: boolean;
  supportedYears: number[];
  /** The state's withholding certificate (null when the state uses the federal W-4 or has no wage tax). */
  certificate: {
    formName: string;
    /** `filingStatus` options, if the form has one. */
    filingStatuses?: string[];
    usesAllowances: boolean;
    fields: StateCertificateFieldDef[];
  } | null;
  /**
   * Employer-specific rates the module reads from `extraRates` (percent), for
   * the employer setup UI. Labels: STATE_EMPLOYER_RATE_LABELS[labelKey]
   * (us/states/labels.ts). `defaultPercent` is what the module uses when the
   * rate is not entered (absent when the default depends on other settings).
   * The SUI rate itself is `suiRatePercent`, not one of these.
   */
  employerRateCodes?: Array<{ code: string; labelKey: string; defaultPercent?: number }>;
  calculate(input: StateCalcInput): StateCalcResult;
}
