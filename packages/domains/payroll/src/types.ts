/**
 * The payroll engine contract.
 *
 * hr-api gathers everything one employee's payslip depends on into a
 * `NlPayslipInput` or `UsPayslipInput` (all plain data, amounts in cents) and
 * calls `calculatePayslip`. The engine is a pure function of that input: no
 * clock, no database, no randomness. The same input always gives the same
 * payslip, which is what makes a calculation reproducible years later from
 * the stored snapshot.
 *
 * Rules are versioned per tax year inside each country module (`nl/rules-2026`,
 * `us/federal-2026`, …). A result names the rule set it used.
 */

import type { Cents } from './money';

export type PayrollCountry = 'NL' | 'US';
export type PayFrequency = 'monthly' | 'four_weekly' | 'semimonthly' | 'biweekly' | 'weekly';

/** One pay period, as the run computed it from its schedule. Dates are `YYYY-MM-DD`. */
export interface PayPeriod {
  start: string;
  end: string;
  payDate: string;
  frequency: PayFrequency;
  /** NL: the calendar year of the period. US: the calendar year of the pay date (wages are taxed when paid). */
  taxYear: number;
  /** 1-based number of this period in the tax year. */
  periodNumber: number;
  /** 12, 13, 24, 26 or 52 (53 when the year has an extra weekly payday). */
  periodsPerYear: number;
}

export interface PayrollIssue {
  severity: 'error' | 'warning';
  /** Stable code the UI translates (see `ISSUE_CODES`). */
  code: string;
  params?: Record<string, string | number>;
}

/** A payslip line. Amounts in cents; negative = deducted from pay. Mirrors `HrPayslipLine` in @weldsuite/db. */
export interface PayslipLine {
  code: string;
  section: 'earning' | 'deduction' | 'tax' | 'reimbursement' | 'employer' | 'info';
  /** Key in `PAYSLIP_LABELS` (payslip-labels.ts), e.g. `nl.wage_tax`. */
  labelKey: string;
  /** User-entered name (a custom component) shown instead of the translated label. */
  label?: string | null;
  quantity?: number | null;
  rate?: number | null;
  amountCents: Cents;
  /** Wage bases this line counts toward (`nl.loon_lb`, `us.fit_wages`, `us.ss_wages`, …). */
  bases?: string[];
  /** `federal`, a US state code, or null. */
  jurisdiction?: string | null;
}

/** Pay in force for the period (the compensation row effective on the period's last day). */
export interface CompensationInput {
  payType: 'salary' | 'hourly';
  /** Decimal amount per `period` (salary) or per hour (hourly), in currency units. */
  amount: number;
  period: 'hour' | 'week' | 'month' | 'year';
  /** Contract hours per week the salary is for. */
  hoursPerWeek: number | null;
}

/** A recurring component in force for the period (`hr_pay_components`). */
export interface ComponentInput {
  code: string;
  label?: string | null;
  /** Per pay period; null when the code computes it from `params`. */
  amountCents: Cents | null;
  params: Record<string, number | string | boolean | null>;
}

/** A pay-run input (`hr_pay_run_inputs`): hours, a bonus, an expense, a one-off deduction. */
export interface RunInput {
  code: string;
  label?: string | null;
  quantity: number | null;
  /** Per unit, currency units (e.g. an hourly rate or an overtime percentage for `nl.overtime`). */
  rate: number | null;
  amountCents: Cents | null;
  /** The day the hours were worked (US overtime is computed per FLSA workweek from these). */
  workDate: string | null;
}

interface PayslipInputBase {
  period: PayPeriod;
  employee: {
    dateOfBirth: string | null;
    /** Employment (or payroll) start and end; pay is prorated for a partial first or last period. */
    startDate: string | null;
    endDate: string | null;
  };
  compensation: CompensationInput | null;
  components: ComponentInput[];
  inputs: RunInput[];
  /** Accumulators of earlier final payslips in the same tax year, same employer, keyed by engine accumulator. */
  ytd: Record<string, Cents>;
}

export interface NlPayslipInput extends PayslipInputBase {
  country: 'NL';
  employer: {
    /** Whk percent from the employer's beschikking; null falls back to the sector's small-employer rate. */
    whkRatePercent: number | null;
    sectorCode: number | null;
    aofSmallEmployer: boolean;
    holidayAllowancePercent: number;
    /** Month the reserved holiday allowance is paid out (5 = May); null pays it monthly. */
    holidayAllowancePayoutMonth: number | null;
  };
  nl: {
    /** Loonheffingskorting requested by the employee (dated, signed election in force). */
    applyLoonheffingskorting: boolean;
    /** Anonymous rate (52%) when name/BSN/ID check is missing. */
    anonymous: boolean;
    isDga: boolean;
    insuredWw: boolean;
    insuredZw: boolean;
    insuredWao: boolean;
    writtenContract: boolean;
    indefiniteContract: boolean;
    onCall: boolean;
    contractHoursPerWeek: number | null;
    /** 30% ruling in force for this period, as a percentage of the wage paid tax-free. */
    expatRulingPercent: number | null;
    /**
     * Annual wage of the previous calendar year (loon voor de loonbelasting),
     * for the special-reward table. Null = first year of employment: the engine
     * annualises the current period wage, as the Handboek prescribes.
     */
    previousYearAnnualWageCents: Cents | null;
  };
}

/** Federal W-4 in force (mirrors `HrUsW4Election`). */
export interface UsW4Input {
  formYear: number;
  filingStatus: 'single' | 'married_jointly' | 'head_of_household';
  multipleJobs: boolean;
  dependentsAmount: number;
  otherIncome: number;
  deductions: number;
  extraWithholding: number;
  exempt: boolean;
  allowances: number | null;
  nonresidentAlien: boolean;
}

/** A state withholding certificate in force (mirrors `HrUsStateCertificateElection`). */
export interface UsStateCertificateInput {
  filingStatus: string | null;
  allowances: number | null;
  values: Record<string, number | string | boolean | null>;
  extraWithholding: number | null;
  exempt: boolean;
}

export interface UsPayslipInput extends PayslipInputBase {
  country: 'US';
  employer: {
    /** 0 = Sunday … 6 = Saturday. */
    workweekStartDay: number;
    /** Employer SUI rate in percent per state, for this tax year. */
    suiRatePercent: Record<string, number | null>;
    /** Other employer-specific rates per state, percent, keyed by the state module's rate code. */
    extraRates: Record<string, Record<string, number>>;
    employeeCountEstimate: number | null;
  };
  us: {
    workState: string | null;
    residenceState: string | null;
    flsaStatus: 'exempt' | 'nonexempt';
    /** Null = no W-4 on file: withhold as Single with no adjustments (Pub 15-T). */
    w4: UsW4Input | null;
    /** Keyed by state code. */
    stateCertificates: Record<string, UsStateCertificateInput>;
    exemptFica: boolean;
    exemptFuta: boolean;
    statutoryEmployee: boolean;
    retirementPlan: boolean;
  };
}

export type PayslipInput = NlPayslipInput | UsPayslipInput;

export interface PayslipResult {
  lines: PayslipLine[];
  grossCents: Cents;
  /** NL: loon voor de loonbelasting; US: federal income tax wages. */
  taxableWageCents: Cents;
  employeeTaxesCents: Cents;
  /** Pre- and post-tax deductions other than taxes. */
  employeeDeductionsCents: Cents;
  reimbursementsCents: Cents;
  netCents: Cents;
  employerTaxesCents: Cents;
  /** Gross + employer taxes + employer contributions + reimbursements. */
  employerCostCents: Cents;
  /** Accumulators after this payslip (input `ytd` plus this period). */
  ytd: Record<string, Cents>;
  /** What the filings need from this payslip; `NlFilingData` or `UsFilingData`. */
  filingData: NlFilingData | UsFilingData;
  issues: PayrollIssue[];
  /** e.g. `nl-2026.4`, `us-2026.1`. */
  ruleSet: string;
}

// ---------------------------------------------------------------------------
// Filing data
// ---------------------------------------------------------------------------

/**
 * One Dutch payslip's contribution to the loonaangifte: the figures of one
 * income relationship (IKV) for one period, in engine terms. The loonaangifte
 * builder maps these onto the Belastingdienst's element names.
 */
export interface NlFilingData {
  kind: 'nl';
  /** Loonbelastingtabel code for the IKV (`CdLbTab`), e.g. `010` white table. */
  tableCode: string;
  applyLoonheffingskorting: boolean;
  anonymous: boolean;
  insured: { ww: boolean; zw: boolean; wao: boolean };
  awfRate: 'low' | 'high';
  aofRate: 'low' | 'high';
  /** Zvw: employer levy (`K`-type code chosen by the builder), withheld contribution, or none. */
  zvw: 'employer_levy' | 'withheld' | 'none';
  contract: { written: boolean; indefinite: boolean; onCall: boolean };
  /** Amounts for this period, cents. */
  amounts: {
    /** Loon voor de loonbelasting/volksverzekeringen (incl. special rewards). */
    loonLbPh: Cents;
    /** Loon voor de werknemersverzekeringen (before the premium cap). */
    loonSv: Cents;
    /** Premieloon AWf / Aof / Ufo / Whk (capped at the maximum premieloon). */
    premieloonAwf: Cents;
    premieloonAof: Cents;
    premieloonWhk: Cents;
    /** Loon voor de Zvw (capped). */
    loonZvw: Cents;
    /** Part of `loonLbPh` taxed with the special-reward table. */
    loonTabelBijzondereBeloningen: Cents;
    /** Withheld loonbelasting/premie volksverzekeringen. */
    wageTax: Cents;
    /** Arbeidskorting taken into account. */
    labourCredit: Cents;
    awfPremium: Cents;
    aofPremium: Cents;
    wkoPremium: Cents;
    whkPremium: Cents;
    zvwEmployerLevy: Cents;
    zvwWithheld: Cents;
    holidayAllowancePaid: Cents;
    /** Opgebouwde rechten vakantiebijslag this period. */
    holidayAllowanceAccrued: Cents;
    companyCarValue: Cents;
    companyCarEmployeeContribution: Cents;
    /** Employee pension premium deducted from the wage. */
    pensionEmployee: Cents;
    /** Tax-free allowances under the WKR targeted exemptions (travel, home working, 30%). */
    taxFreeAllowances: Cents;
  };
  /** Verloonde uren (hours paid) this period. */
  hoursPaid: number;
  /** Social-insurance days (SV-dagen). */
  svDays: number;
}

/** One US payslip's contribution to the federal and state filings. Cents. */
export interface UsFilingData {
  kind: 'us';
  federal: {
    /** Box 1 / 941 line 2. */
    fitWages: Cents;
    federalIncomeTax: Cents;
    /** Box 3 / 941 line 5a. */
    ssWages: Cents;
    ssTaxEmployee: Cents;
    ssTaxEmployer: Cents;
    /** Box 5 / 941 line 5c. */
    medicareWages: Cents;
    medicareTaxEmployee: Cents;
    medicareTaxEmployer: Cents;
    /** 941 line 5d. */
    additionalMedicareWages: Cents;
    additionalMedicareTax: Cents;
    /** 940: total payments, and the part above the $7,000 base. */
    futaGrossWages: Cents;
    futaWages: Cents;
    futaTax: Cents;
    /** Box 7 / 941 line 5b. */
    ssTips: Cents;
    /** W-2 box 12 amounts by code (D 401(k), DD employer health, W HSA, TT overtime, TP tips, …). */
    box12: Record<string, Cents>;
    /** W-2 box 10 dependent care. */
    dependentCare: Cents;
  };
  /** Per state code. */
  states: Record<
    string,
    {
      stateWages: Cents;
      stateIncomeTax: Cents;
      suiWages: Cents;
      suiGrossWages: Cents;
      suiEmployerTax: Cents;
      suiEmployeeTax: Cents;
      /** SDI / PFML / FLI / WA Cares… by program code, employee and employer shares. */
      programs: Record<string, { wages: Cents; employee: Cents; employer: Cents }>;
    }
  >;
  /** FLSA overtime premium (half-time part) for W-2 code TT. */
  qualifiedOvertimePremium: Cents;
  hoursWorked: number;
}

/**
 * The engine entry point (implemented in index.ts). `PayslipResult.ruleSet`
 * names the rules used; an unsupported tax year or state is an `error` issue
 * in the result, never an exception.
 */
export type CalculatePayslip = (input: PayslipInput) => PayslipResult;
