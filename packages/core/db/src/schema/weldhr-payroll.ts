/**
 * WeldHR payroll — WeldSuite's own payroll for the Netherlands and the United
 * States. Tenant DB. Plan: docs/plans/weldhr-payroll.md.
 *
 * WeldSuite calculates; the employer pays. Nothing here holds money: a pay run
 * ends in payslips, a payment file (SEPA pain.001 / NACHA) the employer uploads
 * to its own bank, a WeldBooks journal entry, and the period's tax filing
 * (NL loonaangifte XML; US 941/940/W-2 and state figures the employer files).
 *
 * Amounts the UI sums or compares (compensation, payslip totals) are plain
 * numeric columns behind the `payroll:*` permissions. Identifiers and bank
 * details stay in encrypted blobs: the employee's in
 * `hr_employees.sensitive_encrypted`, the employer's in `bank_encrypted`.
 *
 * History is never rewritten. Compensation, recurring pay components and tax
 * elections are effective-dated rows; an approved payslip is final and a
 * mistake is fixed by a correction run, which the next filing reports.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  doublePrecision,
  numeric,
  date,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

export type HrPayrollCountry = 'NL' | 'US';

/** NL v1 runs `monthly` only; the US supports all four US frequencies. */
export type HrPayFrequency = 'monthly' | 'four_weekly' | 'semimonthly' | 'biweekly' | 'weekly';

export interface HrPayrollAddress {
  line1?: string | null;
  line2?: string | null;
  /** NL: house number kept apart from the street for the loonaangifte. */
  houseNumber?: string | null;
  houseNumberAddition?: string | null;
  postalCode?: string | null;
  city?: string | null;
  /** US state code (`CA`) or NL province; free text elsewhere. */
  region?: string | null;
  /** ISO 3166-1 alpha-2. */
  country?: string | null;
}

/** The employer's settings for one Dutch tax year, from the Belastingdienst's beschikkingen. */
export interface HrPayrollEmployerNlYear {
  /** Whk premium in percent (e.g. 1.16). Small employers: the sector rate; others: their own rate. */
  whkRate?: number | null;
  /** Aof: small employer (low rate) when total premium wage two years earlier was under the limit. */
  aofSmallEmployer?: boolean | null;
}

export interface HrPayrollEmployerNlSettings {
  /** Loonheffingennummer, e.g. `123456789L01`. */
  loonheffingennummer?: string | null;
  /** Sectorindeling code (two digits), set by the Belastingdienst. */
  sectorCode?: number | null;
  /** Keyed by tax year (`'2026'`). */
  years?: Record<string, HrPayrollEmployerNlYear>;
  /** Vakantiebijslag in percent of wage. Default 8. */
  holidayAllowancePercent?: number | null;
  /** Month the reserved holiday allowance is paid (5 = May). Null pays it every month. */
  holidayAllowancePayoutMonth?: number | null;
  /** Language of payslips and annual statements. */
  payslipLanguage?: 'nl' | 'en' | null;
  /** Contact person printed in the loonaangifte. */
  contactName?: string | null;
  contactPhone?: string | null;
}

/** One US state the employer has employees in. */
export interface HrPayrollEmployerUsState {
  withholdingAccountNumber?: string | null;
  suiAccountNumber?: string | null;
  /** Employer SUI rate in percent per tax year, from the state's rate notice. */
  suiRates?: Record<string, number>;
  /**
   * Other employer-specific rates per tax year, keyed by the engine's rate code
   * (e.g. `nj_employer_tdi`, `ma_pfml_employer_share`). Percent.
   */
  extraRates?: Record<string, Record<string, number>>;
}

export interface HrPayrollEmployerUsSettings {
  /** Federal EIN, `12-3456789`. */
  ein?: string | null;
  /** From the lookback period. */
  depositSchedule?: 'monthly' | 'semiweekly' | null;
  /** First day of the FLSA workweek, 0 = Sunday … 6 = Saturday. Default 0. */
  workweekStartDay?: number | null;
  /** Keyed by state code. */
  states?: Record<string, HrPayrollEmployerUsState>;
  /** Employees on the payroll, for size-dependent rules (WA PFML, ME/MD leave). */
  employeeCountEstimate?: number | null;
}

/** Decrypted shape of `hr_payroll_employers.bank_encrypted`: the account salaries are paid from. */
export interface HrPayrollEmployerBank {
  accountHolder?: string | null;
  iban?: string | null;
  bic?: string | null;
  routingNumber?: string | null;
  accountNumber?: string | null;
  accountType?: 'checking' | 'savings' | null;
  /** NACHA: the immediate origin / company id the bank assigned (often `1` + EIN). */
  nachaCompanyId?: string | null;
  /** NACHA: the ODFI's name, for the file header. */
  bankName?: string | null;
}

export type HrPayDateRule =
  /** Fixed day of the month (25 = the 25th; 31 clamps to the last day). Semimonthly: the second payday is the last day. */
  | { kind: 'day_of_month'; day: number }
  /** A number of days after the period ends (US weekly/biweekly, typically 3–7). */
  | { kind: 'offset_after_end'; days: number }
  /** Last weekday of the period's month. */
  | { kind: 'last_business_day' };

export type HrPayrollStatus = 'active' | 'paused' | 'ended';

export interface HrPayrollProfileNl {
  /** Written, open-ended contract (AWf low rate needs both). */
  writtenContract?: boolean;
  indefiniteContract?: boolean;
  /** Oproepovereenkomst — on-call contracts pay the AWf high rate. */
  onCall?: boolean;
  /** Director-major shareholder: not insured for WW/ZW/WIA; Zvw is withheld. */
  isDga?: boolean;
  /** Overrides the default insured-ness derived from `isDga`. */
  insuredWw?: boolean | null;
  insuredZw?: boolean | null;
  insuredWao?: boolean | null;
  /** Income relationship number (nummer inkomstenverhouding), stable per employment. */
  incomeRelationshipNumber?: number | null;
  /** CAO code for the loonaangifte; v1 uses 9999 (no CAO). */
  caoCode?: number | null;
  /** 30% ruling (expatregeling). */
  expatRuling?: { from: string; to?: string | null; percent: number } | null;
  /** Surname prefix ("van der"), kept apart for the loonaangifte. */
  surnamePrefix?: string | null;
  /** Initials, e.g. `J.M.`; derived from the first name when empty. */
  initials?: string | null;
  /** 1 = male, 2 = female, 0 = unknown (loonaangifte `Gesl`). */
  gender?: 0 | 1 | 2 | null;
  /** ISO 3166-1 alpha-2 nationality. */
  nationality?: string | null;
  /** Agreed hours per week for the payslip and SV-days; defaults to the employee's weekly hours. */
  contractHoursPerWeek?: number | null;
}

export interface HrPayrollProfileUs {
  /** State the employee works in (two-letter code). */
  workState?: string | null;
  /** State the employee lives in. */
  residenceState?: string | null;
  flsaStatus?: 'exempt' | 'nonexempt' | null;
  /** W-2 box 13. */
  statutoryEmployee?: boolean;
  retirementPlan?: boolean;
  /** FICA/FUTA exemptions (e.g. certain family employees); rarely set. */
  exemptFica?: boolean;
  exemptFuta?: boolean;
}

export type HrTaxElectionKind = 'nl_loonheffingskorting' | 'us_w4' | 'us_state_certificate';

export interface HrNlLoonheffingskortingElection {
  /** True = the employee asked for the tax credits to be applied by this employer. */
  applyCredit: boolean;
}

export interface HrUsW4Election {
  /** 2020+ for the redesigned form; earlier years use allowances (computational bridge). */
  formYear: number;
  filingStatus: 'single' | 'married_jointly' | 'head_of_household';
  /** Step 2 checkbox. */
  multipleJobs: boolean;
  /** Step 3, annual dollars. */
  dependentsAmount: number;
  /** Step 4(a), annual dollars. */
  otherIncome: number;
  /** Step 4(b), annual dollars. */
  deductions: number;
  /** Step 4(c), dollars per pay period. */
  extraWithholding: number;
  exempt: boolean;
  /** Pre-2020 forms only. */
  allowances?: number | null;
  nonresidentAlien?: boolean;
}

/** A state withholding certificate (DE 4, IT-2104, IL-W-4, …). Fields per state; see the US engine. */
export interface HrUsStateCertificateElection {
  filingStatus?: string | null;
  allowances?: number | null;
  /** Additional allowances / deductions some states have (CA estimated deductions, NJ rate table…). */
  values?: Record<string, number | string | boolean | null>;
  extraWithholding?: number | null;
  exempt?: boolean;
}

export type HrPayRunKind = 'regular' | 'off_cycle' | 'correction';
export type HrPayRunStatus = 'draft' | 'calculated' | 'approved' | 'paid' | 'cancelled';

/** Totals in cents. */
export interface HrPayRunTotals {
  grossCents: number;
  netCents: number;
  employeeTaxesCents: number;
  employeeDeductionsCents: number;
  employerTaxesCents: number;
  reimbursementsCents: number;
  employerCostCents: number;
}

export interface HrPayrollIssue {
  severity: 'error' | 'warning';
  /** Stable code the UI translates (`missing_bank_account`, `below_minimum_wage`, …). */
  code: string;
  employeeId?: string | null;
  /** Values for the translated message. */
  params?: Record<string, string | number>;
}

export type HrPayRunInputSource = 'manual' | 'attendance' | 'leave' | 'absence' | 'declaration';

export type HrPayslipStatus = 'draft' | 'final' | 'void';

/** One payslip line, as the engine produced it. Amounts in cents; negative = deducted from pay. */
export interface HrPayslipLine {
  /** Engine code, e.g. `nl.salary`, `nl.wage_tax`, `us.federal_income_tax`. */
  code: string;
  /** Section on the payslip. */
  section: 'earning' | 'deduction' | 'tax' | 'reimbursement' | 'employer' | 'info';
  /** Translation key the PDF and UI use; `label` overrides it for user-named components. */
  labelKey: string;
  label?: string | null;
  quantity?: number | null;
  rate?: number | null;
  amountCents: number;
  /** Which bases this line counts in (`nl.loon_lb`, `us.fit_wages`, …). */
  bases?: string[];
  jurisdiction?: string | null;
}

export type HrPayrollFilingKind =
  | 'nl_loonaangifte'
  | 'us_941'
  | 'us_940'
  | 'us_w2'
  | 'us_state_withholding'
  | 'us_state_unemployment';

export type HrPayrollFilingStatus =
  /** Still collecting pay runs for the period. */
  | 'open'
  /** Generated and checked; waiting to be submitted (NL) or filed by the employer (US). */
  | 'ready'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  /** The employer reports it filed this itself. */
  | 'filed';

export interface HrPayrollFilingEvent {
  at: string;
  status: HrPayrollFilingStatus;
  by?: string | null;
  message?: string | null;
}

// ---------------------------------------------------------------------------
// Employers and schedules
// ---------------------------------------------------------------------------

/**
 * The legal employer: the company whose payroll tax number (NL) or EIN (US)
 * the pay runs and filings are under. Optionally linked to a WeldBooks
 * accounting entity, which is where approved pay runs post their journal.
 */
export const hrPayrollEmployers = pgTable('hr_payroll_employers', {
  id: varchar('id', { length: 30 }).primaryKey(),
  name: varchar('name', { length: 160 }).notNull(),
  legalName: varchar('legal_name', { length: 255 }).notNull(),
  country: varchar('country', { length: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  /** WeldBooks `entities.id`; approved runs post their journal there. */
  accountingEntityId: varchar('accounting_entity_id', { length: 30 }),
  address: jsonb('address').$type<HrPayrollAddress>().notNull().default({}),
  nlSettings: jsonb('nl_settings').$type<HrPayrollEmployerNlSettings>().notNull().default({}),
  usSettings: jsonb('us_settings').$type<HrPayrollEmployerUsSettings>().notNull().default({}),
  /** AES-GCM blob of `HrPayrollEmployerBank`. */
  bankEncrypted: text('bank_encrypted'),
  /** Four eyes: the member who calculated a run may not approve it. */
  requireSeparateApprover: boolean('require_separate_approver').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_payroll_employers_country_idx').on(table.country),
]);

export const hrPaySchedules = pgTable('hr_pay_schedules', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employerId: varchar('employer_id', { length: 30 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  frequency: varchar('frequency', { length: 20 }).notNull(),
  /** Start of the first period; every later period follows from it and the frequency. */
  anchorDate: date('anchor_date').notNull(),
  payDateRule: jsonb('pay_date_rule').$type<HrPayDateRule>().notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_pay_schedules_employer_idx').on(table.employerId),
]);

// ---------------------------------------------------------------------------
// Per-employee payroll data
// ---------------------------------------------------------------------------

/** Who is on payroll, for which employer and schedule. One row per employee. */
export const hrPayrollProfiles = pgTable('hr_payroll_profiles', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  employerId: varchar('employer_id', { length: 30 }).notNull(),
  payScheduleId: varchar('pay_schedule_id', { length: 30 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  /** First and last day on this payroll; default the employment dates. */
  startDate: date('start_date'),
  endDate: date('end_date'),
  nl: jsonb('nl').$type<HrPayrollProfileNl>().notNull().default({}),
  us: jsonb('us').$type<HrPayrollProfileUs>().notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hr_payroll_profiles_employee_uidx').on(table.employeeId),
  index('hr_payroll_profiles_employer_idx').on(table.employerId),
]);

/** Effective-dated pay. The row in force on a period's last day is the one a run uses. */
export const hrCompensations = pgTable('hr_compensations', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  effectiveFrom: date('effective_from').notNull(),
  /** Inclusive; null = open-ended. Set automatically when a newer row starts. */
  effectiveTo: date('effective_to'),
  /** `salary` pays `amount` per `period`; `hourly` pays `amount` per hour worked. */
  payType: varchar('pay_type', { length: 10 }).notNull(),
  amount: numeric('amount', { precision: 14, scale: 4 }).notNull(),
  period: varchar('period', { length: 10 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  /** Contract hours the salary is for; used for hourly-equivalent and part-time checks. */
  hoursPerWeek: doublePrecision('hours_per_week'),
  reason: text('reason'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_compensations_employee_idx').on(table.employeeId, table.effectiveFrom),
]);

/**
 * Recurring earnings and deductions: company car, travel allowance, pension
 * contribution, 401(k), a fixed net deduction… The `code` comes from the
 * engine's component catalog (`@weldsuite/payroll-domain/components`), which
 * says how it is taxed; `params` carries what the code needs (list price,
 * kilometres, percentage).
 */
export const hrPayComponents = pgTable('hr_pay_components', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  code: varchar('code', { length: 60 }).notNull(),
  label: varchar('label', { length: 160 }),
  /** Per pay period. Null when the code computes it from `params`. */
  amount: numeric('amount', { precision: 14, scale: 2 }),
  params: jsonb('params').$type<Record<string, number | string | boolean | null>>().notNull().default({}),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
}, (table) => [
  index('hr_pay_components_employee_idx').on(table.employeeId),
]);

/**
 * Signed tax choices, effective-dated: the Dutch loonheffingskorting request,
 * the US W-4 and state withholding certificates. A new row supersedes the old
 * one from its `effective_from`; rows are never edited.
 */
export const hrTaxElections = pgTable('hr_tax_elections', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  kind: varchar('kind', { length: 30 }).notNull(),
  /** US state code for `us_state_certificate`. */
  state: varchar('state', { length: 2 }),
  effectiveFrom: date('effective_from').notNull(),
  data: jsonb('data')
    .$type<HrNlLoonheffingskortingElection | HrUsW4Election | HrUsStateCertificateElection>()
    .notNull(),
  /** Clerk user id, or `portal:<employeeId>` when the employee signed in the portal. */
  signedBy: varchar('signed_by', { length: 255 }),
  /** The name the signer typed. */
  signatureName: varchar('signature_name', { length: 255 }),
  signedAt: timestamp('signed_at'),
  /** `employee` when signed by the employee themselves, `admin` when entered from a paper form. */
  source: varchar('source', { length: 20 }).notNull().default('admin'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('hr_tax_elections_employee_idx').on(table.employeeId, table.kind, table.effectiveFrom),
]);

// ---------------------------------------------------------------------------
// Pay runs and payslips
// ---------------------------------------------------------------------------

export const hrPayRuns = pgTable('hr_pay_runs', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employerId: varchar('employer_id', { length: 30 }).notNull(),
  payScheduleId: varchar('pay_schedule_id', { length: 30 }),
  country: varchar('country', { length: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull().default('regular'),
  /** For `correction` runs: the run whose payslips are corrected. */
  correctsRunId: varchar('corrects_run_id', { length: 30 }),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  payDate: date('pay_date').notNull(),
  taxYear: integer('tax_year').notNull(),
  /** Period number within the tax year (1–12 monthly, 1–52/53 weekly…). */
  periodNumber: integer('period_number').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  employeeCount: integer('employee_count').notNull().default(0),
  /** Employees on the schedule left out of this run (paid in a later or off-cycle run). */
  excludedEmployeeIds: jsonb('excluded_employee_ids').$type<string[]>().notNull().default([]),
  /** Off-cycle and correction runs: only these employees. Null = everyone on the schedule. */
  includedEmployeeIds: jsonb('included_employee_ids').$type<string[] | null>(),
  totals: jsonb('totals').$type<HrPayRunTotals | null>(),
  issues: jsonb('issues').$type<HrPayrollIssue[]>().notNull().default([]),
  notes: text('notes'),
  preparedBy: varchar('prepared_by', { length: 255 }),
  calculatedBy: varchar('calculated_by', { length: 255 }),
  calculatedAt: timestamp('calculated_at'),
  approvedBy: varchar('approved_by', { length: 255 }),
  approvedAt: timestamp('approved_at'),
  paidBy: varchar('paid_by', { length: 255 }),
  paidAt: timestamp('paid_at'),
  cancelledAt: timestamp('cancelled_at'),
  /** WeldBooks posting of the approved run. */
  journalStatus: varchar('journal_status', { length: 20 }).notNull().default('not_linked'),
  journalEntryId: varchar('journal_entry_id', { length: 30 }),
  journalError: text('journal_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_pay_runs_employer_period_idx').on(table.employerId, table.periodStart),
  index('hr_pay_runs_status_idx').on(table.status),
  // One live regular run per schedule and period.
  uniqueIndex('hr_pay_runs_regular_uidx')
    .on(table.payScheduleId, table.periodStart)
    .where(sql`kind = 'regular' AND status <> 'cancelled'`),
]);

/**
 * What changes pay this period: hours worked, overtime, leave, bonuses,
 * one-off allowances and deductions, reimbursed expenses. Some are collected
 * from attendance, leave and declarations when the run is prepared
 * (`source` + `source_ref`); the rest are typed in.
 */
export const hrPayRunInputs = pgTable('hr_pay_run_inputs', {
  id: varchar('id', { length: 30 }).primaryKey(),
  runId: varchar('run_id', { length: 30 }).notNull(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  /** Component code from the engine catalog (`hours.regular`, `bonus`, `nl.leave_payout`, …). */
  code: varchar('code', { length: 60 }).notNull(),
  label: varchar('label', { length: 160 }),
  quantity: numeric('quantity', { precision: 12, scale: 4 }),
  rate: numeric('rate', { precision: 14, scale: 4 }),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  /** Workweek start (US overtime) or work date the hours belong to. */
  workDate: date('work_date'),
  source: varchar('source', { length: 20 }).notNull().default('manual'),
  sourceRef: varchar('source_ref', { length: 30 }),
  notes: text('notes'),
  createdBy: varchar('created_by', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('hr_pay_run_inputs_run_idx').on(table.runId, table.employeeId),
  index('hr_pay_run_inputs_source_idx').on(table.source, table.sourceRef),
]);

export const hrPayslips = pgTable('hr_payslips', {
  id: varchar('id', { length: 30 }).primaryKey(),
  runId: varchar('run_id', { length: 30 }).notNull(),
  employeeId: varchar('employee_id', { length: 30 }).notNull(),
  employerId: varchar('employer_id', { length: 30 }).notNull(),
  country: varchar('country', { length: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  /** Sequential per employer and year once final, e.g. `2026-0007`. */
  number: varchar('number', { length: 30 }),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  payDate: date('pay_date').notNull(),
  taxYear: integer('tax_year').notNull(),
  periodNumber: integer('period_number').notNull(),
  grossPay: numeric('gross_pay', { precision: 14, scale: 2 }).notNull().default('0'),
  /** NL: loon voor de loonbelasting; US: federal income tax wages. */
  taxableWage: numeric('taxable_wage', { precision: 14, scale: 2 }).notNull().default('0'),
  employeeTaxes: numeric('employee_taxes', { precision: 14, scale: 2 }).notNull().default('0'),
  employeeDeductions: numeric('employee_deductions', { precision: 14, scale: 2 }).notNull().default('0'),
  reimbursements: numeric('reimbursements', { precision: 14, scale: 2 }).notNull().default('0'),
  netPay: numeric('net_pay', { precision: 14, scale: 2 }).notNull().default('0'),
  employerTaxes: numeric('employer_taxes', { precision: 14, scale: 2 }).notNull().default('0'),
  employerCost: numeric('employer_cost', { precision: 14, scale: 2 }).notNull().default('0'),
  lines: jsonb('lines').$type<HrPayslipLine[]>().notNull().default([]),
  /** Year-to-date accumulators after this payslip, in cents, keyed by engine accumulator. */
  ytd: jsonb('ytd').$type<Record<string, number>>().notNull().default({}),
  /**
   * What the filing needs from this payslip (NL IKV figures and indicators; US
   * wages and taxes per jurisdiction). Engine-defined; see the domain package.
   */
  filingData: jsonb('filing_data').$type<Record<string, unknown>>().notNull().default({}),
  /** The inputs as calculated (compensation, profile, elections, rule set), for audit and recalculation. */
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default({}),
  issues: jsonb('issues').$type<HrPayrollIssue[]>().notNull().default([]),
  /** For payslips in a correction run: the payslip it corrects. */
  correctsPayslipId: varchar('corrects_payslip_id', { length: 30 }),
  /** R2 key of the rendered PDF (`workspaces/<id>/hr/payslips/…`), set when final. */
  fileKey: varchar('file_key', { length: 500 }),
  employeeViewedAt: timestamp('employee_viewed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hr_payslips_run_employee_uidx').on(table.runId, table.employeeId),
  index('hr_payslips_employee_idx').on(table.employeeId, table.payDate),
  index('hr_payslips_employer_year_idx').on(table.employerId, table.taxYear),
]);

// ---------------------------------------------------------------------------
// Filings
// ---------------------------------------------------------------------------

/**
 * A tax return or report for one employer and period: the Dutch loonaangifte
 * per month, US 941 per quarter, 940 and W-2 per year, state withholding and
 * unemployment reports. Built from final payslips; `file_key` holds the
 * generated XML / PDF / CSV in R2.
 */
export const hrPayrollFilings = pgTable('hr_payroll_filings', {
  id: varchar('id', { length: 30 }).primaryKey(),
  employerId: varchar('employer_id', { length: 30 }).notNull(),
  country: varchar('country', { length: 2 }).notNull(),
  kind: varchar('kind', { length: 40 }).notNull(),
  /** US state code for state filings; null otherwise. */
  state: varchar('state', { length: 2 }),
  taxYear: integer('tax_year').notNull(),
  /** Month (1–12) for NL, quarter (1–4) for 941 and state quarterlies, 0 for annual filings. */
  period: integer('period').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  dueDate: date('due_date'),
  status: varchar('status', { length: 20 }).notNull().default('open'),
  /** Times this filing was regenerated after being submitted (NL resubmission before the deadline). */
  version: integer('version').notNull().default(1),
  /** Totals per line of the return, in cents. */
  summary: jsonb('summary').$type<Record<string, number>>().notNull().default({}),
  amountDue: numeric('amount_due', { precision: 14, scale: 2 }).notNull().default('0'),
  /** NL betalingskenmerk for the period's payment. */
  paymentReference: varchar('payment_reference', { length: 40 }),
  fileKey: varchar('file_key', { length: 500 }),
  fileName: varchar('file_name', { length: 255 }),
  contentType: varchar('content_type', { length: 120 }),
  generatedAt: timestamp('generated_at'),
  /** `digipoort` (NL, sent by WeldSuite) or `manual` (filed by the employer). */
  channel: varchar('channel', { length: 20 }),
  /** Digipoort kenmerk or the employer's confirmation number. */
  externalReference: varchar('external_reference', { length: 120 }),
  submittedBy: varchar('submitted_by', { length: 255 }),
  submittedAt: timestamp('submitted_at'),
  history: jsonb('history').$type<HrPayrollFilingEvent[]>().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hr_payroll_filings_period_uidx').on(
    table.employerId,
    table.kind,
    table.taxYear,
    table.period,
    sql`coalesce(${table.state}, '')`,
  ),
  index('hr_payroll_filings_status_idx').on(table.status, table.dueDate),
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type HrPayrollEmployer = typeof hrPayrollEmployers.$inferSelect;
export type NewHrPayrollEmployer = typeof hrPayrollEmployers.$inferInsert;
export type HrPaySchedule = typeof hrPaySchedules.$inferSelect;
export type HrPayrollProfile = typeof hrPayrollProfiles.$inferSelect;
export type HrCompensation = typeof hrCompensations.$inferSelect;
export type HrPayComponent = typeof hrPayComponents.$inferSelect;
export type HrTaxElection = typeof hrTaxElections.$inferSelect;
export type HrPayRun = typeof hrPayRuns.$inferSelect;
export type HrPayRunInput = typeof hrPayRunInputs.$inferSelect;
export type HrPayslip = typeof hrPayslips.$inferSelect;
export type HrPayrollFiling = typeof hrPayrollFilings.$inferSelect;
