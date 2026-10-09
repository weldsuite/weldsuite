/**
 * App-API WeldHR payroll domain client — `/api/weldhr/payroll/*`, plus the
 * employee's own payslips and payroll details under `/api/weldhr/me/*`.
 *
 * Stored amounts (compensation, payslip totals, filing amounts) come back as
 * decimal strings, exactly as the database holds them. Payslip lines and run
 * totals are integer cents. Identifiers and bank numbers are only ever
 * returned masked; they are write-only through the API.
 */

import type { ClientApi, DataResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateHrCompensationInput,
  CreateHrPayComponentInput,
  CreateHrPayRunInput,
  CreateHrPayRunInputInput,
  CreateHrPayScheduleInput,
  CreateHrPayrollEmployerInput,
  CreateHrTaxElectionInput,
  HrPayrollEmployerBankInput,
  HrPayrollPaymentDetailsInput,
  MarkHrPayRunPaidInput,
  MarkHrPayrollFilingFiledInput,
  SetHrPayRunEmployeeInput,
  UpdateHrPayComponentInput,
  UpdateHrPayRunInput,
  UpdateHrPayRunInputInput,
  UpdateHrPayScheduleInput,
  UpdateHrPayrollEmployerInput,
  UpsertHrPayrollProfileInput,
} from '../schemas/weldhr-payroll';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HrPayrollCountry = 'NL' | 'US';
export type HrPayFrequency = 'monthly' | 'four_weekly' | 'semimonthly' | 'biweekly' | 'weekly';
export type HrPayRunKind = 'regular' | 'off_cycle' | 'correction';
export type HrPayRunStatus = 'draft' | 'calculated' | 'approved' | 'paid' | 'cancelled';
export type HrPayslipStatus = 'draft' | 'final' | 'void';
export type HrPayrollFilingKind =
  | 'nl_loonaangifte'
  | 'us_941'
  | 'us_940'
  | 'us_w2'
  | 'us_state_withholding'
  | 'us_state_unemployment';
export type HrPayrollFilingStatus = 'open' | 'ready' | 'submitted' | 'accepted' | 'rejected' | 'filed';
export type HrTaxElectionKind = 'nl_loonheffingskorting' | 'us_w4' | 'us_state_certificate';
export type HrPayRunInputSource = 'manual' | 'attendance' | 'leave' | 'absence' | 'declaration';
export type HrJournalStatus = 'not_linked' | 'posted' | 'failed' | 'skipped';

export interface HrPayrollIssue {
  severity: 'error' | 'warning';
  /** Translate as `weldhr.payroll.issues.<code>` with `params`. */
  code: string;
  employeeId?: string | null;
  params?: Record<string, string | number>;
}

export interface HrPayrollAddress {
  line1?: string | null;
  line2?: string | null;
  houseNumber?: string | null;
  houseNumberAddition?: string | null;
  postalCode?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
}

export interface HrPayrollEmployerNlSettings {
  loonheffingennummer?: string | null;
  sectorCode?: number | null;
  years?: Record<string, { whkRate?: number | null; aofSmallEmployer?: boolean | null }>;
  holidayAllowancePercent?: number | null;
  holidayAllowancePayoutMonth?: number | null;
  payslipLanguage?: 'nl' | 'en' | null;
  contactName?: string | null;
  contactPhone?: string | null;
}

export interface HrPayrollEmployerUsSettings {
  ein?: string | null;
  depositSchedule?: 'monthly' | 'semiweekly' | null;
  workweekStartDay?: number | null;
  states?: Record<
    string,
    {
      withholdingAccountNumber?: string | null;
      suiAccountNumber?: string | null;
      suiRates?: Record<string, number>;
      extraRates?: Record<string, Record<string, number>>;
    }
  >;
  employeeCountEstimate?: number | null;
}

/** The employer's salary account, masked. */
export interface HrPayrollEmployerBankMasked {
  accountHolder: string | null;
  /** `NL91 •••• •••• 4300` */
  ibanMasked: string | null;
  bic: string | null;
  routingNumber: string | null;
  /** `•••• 6789` */
  accountNumberMasked: string | null;
  accountType: 'checking' | 'savings' | null;
  nachaCompanyId: string | null;
  bankName: string | null;
}

export interface HrPayrollEmployer {
  id: string;
  name: string;
  legalName: string;
  country: HrPayrollCountry;
  currency: string;
  accountingEntityId: string | null;
  accountingEntityName: string | null;
  address: HrPayrollAddress;
  nlSettings: HrPayrollEmployerNlSettings;
  usSettings: HrPayrollEmployerUsSettings;
  requireSeparateApprover: boolean;
  isActive: boolean;
  bank: HrPayrollEmployerBankMasked | null;
  /** Employees with an active payroll profile at this employer. */
  employeeCount: number;
  /** What is still missing before a run can be approved (no loonheffingennummer, no bank…). */
  issues: HrPayrollIssue[];
  createdAt: string;
  updatedAt: string;
}

export type HrPayDateRule =
  | { kind: 'day_of_month'; day: number }
  | { kind: 'offset_after_end'; days: number }
  | { kind: 'last_business_day' };

export interface HrPayPeriod {
  start: string;
  end: string;
  payDate: string;
  frequency: HrPayFrequency;
  taxYear: number;
  periodNumber: number;
  periodsPerYear: number;
}

export interface HrPaySchedule {
  id: string;
  employerId: string;
  name: string;
  frequency: HrPayFrequency;
  anchorDate: string;
  payDateRule: HrPayDateRule;
  isActive: boolean;
  employeeCount: number;
  /** The next period without an approved or paid regular run. */
  nextPeriod: HrPayPeriod | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrPayrollProfileNl {
  writtenContract?: boolean;
  indefiniteContract?: boolean;
  onCall?: boolean;
  isDga?: boolean;
  insuredWw?: boolean | null;
  insuredZw?: boolean | null;
  insuredWao?: boolean | null;
  incomeRelationshipNumber?: number | null;
  caoCode?: number | null;
  endReasonCode?: string | null;
  usualWorkDaysPerWeek?: number | null;
  /** Read only: allocated by WeldSuite when a transitievergoeding is paid (a second income relationship). */
  transitionIncomeRelationshipNumber?: number | null;
  expatRuling?: { from: string; to?: string | null; percent: number } | null;
  surnamePrefix?: string | null;
  initials?: string | null;
  gender?: 0 | 1 | 2 | null;
  nationality?: string | null;
  contractHoursPerWeek?: number | null;
}

export interface HrPayrollProfileUs {
  workState?: string | null;
  residenceState?: string | null;
  flsaStatus?: 'exempt' | 'nonexempt' | null;
  statutoryEmployee?: boolean;
  retirementPlan?: boolean;
  exemptFica?: boolean;
  exemptFuta?: boolean;
}

export interface HrPayrollProfile {
  id: string;
  employeeId: string;
  employerId: string;
  payScheduleId: string | null;
  status: 'active' | 'paused' | 'ended';
  startDate: string | null;
  endDate: string | null;
  nl: HrPayrollProfileNl;
  us: HrPayrollProfileUs;
  createdAt: string;
  updatedAt: string;
}

export interface HrCompensation {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payType: 'salary' | 'hourly';
  /** Decimal string. */
  amount: string;
  period: 'hour' | 'week' | 'month' | 'year';
  currency: string;
  hoursPerWeek: number | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface HrPayComponent {
  id: string;
  employeeId: string;
  code: string;
  label: string | null;
  amount: string | null;
  params: Record<string, number | string | boolean | null>;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrTaxElection {
  id: string;
  employeeId: string;
  kind: HrTaxElectionKind;
  state: string | null;
  effectiveFrom: string;
  data: Record<string, unknown>;
  signedBy: string | null;
  signatureName: string | null;
  signedAt: string | null;
  source: 'employee' | 'admin';
  createdAt: string;
}

/** What payroll holds from the employee's sensitive block, masked. */
export interface HrPayrollPaymentDetailsMasked {
  hasNationalId: boolean;
  /** `•••••1234` */
  nationalIdMasked: string | null;
  dateOfBirth: string | null;
  bankAccountHolder: string | null;
  bankIbanMasked: string | null;
  bankBic: string | null;
  bankRoutingNumber: string | null;
  bankAccountNumberMasked: string | null;
  bankAccountType: 'checking' | 'savings' | null;
  homeAddress: HrPayrollAddress | null;
  idDocumentType: 'passport' | 'id_card' | 'residence_permit' | 'drivers_license' | null;
  idDocumentExpiresOn: string | null;
  idVerifiedAt: string | null;
}

export interface HrPayrollEmployeeListItem {
  employeeId: string;
  displayName: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  employeeStatus: string;
  profile: Pick<HrPayrollProfile, 'employerId' | 'payScheduleId' | 'status'> | null;
  employerName: string | null;
  payScheduleName: string | null;
  country: HrPayrollCountry | null;
  currentCompensation: HrCompensation | null;
  /** Blocking problems first. Empty = ready for the next run. */
  issues: HrPayrollIssue[];
}

export interface HrPayrollEmployeeDetail {
  employee: {
    id: string;
    displayName: string;
    email: string;
    status: string;
    startDate: string | null;
    endDate: string | null;
    weeklyHours: number | null;
  };
  profile: HrPayrollProfile | null;
  employer: Pick<HrPayrollEmployer, 'id' | 'name' | 'country' | 'currency'> | null;
  compensations: HrCompensation[];
  components: HrPayComponent[];
  /** The election of each kind (and state) in force today. */
  currentElections: HrTaxElection[];
  paymentDetails: HrPayrollPaymentDetailsMasked;
  issues: HrPayrollIssue[];
}

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

export interface HrPayRun {
  id: string;
  employerId: string;
  employerName: string;
  payScheduleId: string | null;
  payScheduleName: string | null;
  country: HrPayrollCountry;
  currency: string;
  kind: HrPayRunKind;
  correctsRunId: string | null;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxYear: number;
  periodNumber: number;
  status: HrPayRunStatus;
  employeeCount: number;
  totals: HrPayRunTotals | null;
  issues: HrPayrollIssue[];
  errorCount: number;
  warningCount: number;
  notes: string | null;
  preparedBy: string | null;
  preparedByName: string | null;
  calculatedAt: string | null;
  calculatedByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  paidAt: string | null;
  journalStatus: HrJournalStatus;
  journalEntryId: string | null;
  journalError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HrPayslipSummary {
  id: string;
  employeeId: string;
  employeeName: string;
  status: HrPayslipStatus;
  number: string | null;
  grossPay: string;
  employeeTaxes: string;
  netPay: string;
  employerCost: string;
  issues: HrPayrollIssue[];
  /** Net pay of the employee's previous final payslip, for the variance column. */
  previousNetPay: string | null;
  // Additive: enough to render a payslip list row without fetching each payslip.
  runId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  currency: string;
  employeeDeductions: string;
  reimbursements: string;
}

export interface HrPayRunDetail extends HrPayRun {
  /** Everyone on the schedule (or in the off-cycle run), with whether they are left out. */
  employees: Array<{ employeeId: string; displayName: string; excluded: boolean; issues: HrPayrollIssue[] }>;
  payslips: HrPayslipSummary[];
  /** False when four eyes is on and the caller calculated this run. */
  canApprove: boolean;
  paymentFile: { format: 'sepa' | 'nacha'; available: boolean };
}

export interface HrPayslipLine {
  code: string;
  section: 'earning' | 'deduction' | 'tax' | 'reimbursement' | 'employer' | 'info';
  labelKey: string;
  label?: string | null;
  quantity?: number | null;
  rate?: number | null;
  amountCents: number;
  bases?: string[];
  jurisdiction?: string | null;
}

export interface HrPayslip {
  id: string;
  runId: string;
  employeeId: string;
  employeeName: string;
  employerId: string;
  employerName: string;
  country: HrPayrollCountry;
  currency: string;
  status: HrPayslipStatus;
  number: string | null;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxYear: number;
  periodNumber: number;
  grossPay: string;
  taxableWage: string;
  employeeTaxes: string;
  employeeDeductions: string;
  reimbursements: string;
  netPay: string;
  employerTaxes: string;
  employerCost: string;
  lines: HrPayslipLine[];
  ytd: Record<string, number>;
  issues: HrPayrollIssue[];
  correctsPayslipId: string | null;
  createdAt: string;
}

export interface HrPayRunInput {
  id: string;
  runId: string;
  employeeId: string;
  code: string;
  label: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string | null;
  workDate: string | null;
  source: HrPayRunInputSource;
  sourceRef: string | null;
  notes: string | null;
  createdAt: string;
}

export interface HrPayrollFilingEvent {
  at: string;
  status: HrPayrollFilingStatus;
  by?: string | null;
  message?: string | null;
  /** The filing version the event belongs to. A filing that was sent and later reopened gets a new version. */
  version?: number;
}

export interface HrPayrollFiling {
  id: string;
  employerId: string;
  employerName: string;
  country: HrPayrollCountry;
  kind: HrPayrollFilingKind;
  state: string | null;
  taxYear: number;
  period: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string | null;
  status: HrPayrollFilingStatus;
  version: number;
  /** Line → CENTS (integers), whatever the currency. Line keys are filing-specific (`941.line2`, `TotTeBet`, …). */
  summary: Record<string, number>;
  /** Decimal string in `currency` units. */
  amountDue: string;
  /** Additive: the employer's currency (`EUR` / `USD`), for `amountDue` and the cents in `summary`. */
  currency: string;
  /**
   * Additive: problems found when the filing was last generated (the builder's errors, which stop it from being
   * stored, and its warnings). Translate as `weldhr.payroll.issues.<code>`; `employeeId` is set where known.
   */
  issues: HrPayrollIssue[];
  paymentReference: string | null;
  fileName: string | null;
  generatedAt: string | null;
  channel: 'digipoort' | 'manual' | null;
  externalReference: string | null;
  submittedAt: string | null;
  history: HrPayrollFilingEvent[];
  /** True when WeldSuite can send it (NL loonaangifte with Digipoort enabled). */
  canSubmit: boolean;
}

export interface HrPayrollOverview {
  employers: Array<{ id: string; name: string; country: HrPayrollCountry; employeeCount: number; issues: HrPayrollIssue[] }>;
  setup: {
    hasEmployer: boolean;
    hasSchedule: boolean;
    employeesOnPayroll: number;
    employeesNotReady: number;
  };
  /** The next period of each active schedule, with its run if one exists. */
  upcoming: Array<{
    scheduleId: string;
    scheduleName: string;
    employerId: string;
    employerName: string;
    country: HrPayrollCountry;
    period: HrPayPeriod;
    runId: string | null;
    runStatus: HrPayRunStatus | null;
  }>;
  recentRuns: HrPayRun[];
  /** Filings that are ready or open and due within 45 days, oldest due first. */
  filingsDue: HrPayrollFiling[];
}

export interface HrMyPayslip {
  id: string;
  number: string | null;
  employerName: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  grossPay: string;
  netPay: string;
  viewedAt: string | null;
}

export interface HrAnnualStatement {
  year: number;
  employerId: string;
  employerName: string;
  /** `jaaropgaaf` (NL) or `w2` (US). */
  kind: 'jaaropgaaf' | 'w2';
}

export interface HrMyPayrollDetails {
  /** Null when the employee is not on payroll yet. */
  country: HrPayrollCountry | null;
  employerName: string | null;
  paymentDetails: HrPayrollPaymentDetailsMasked;
  /** Elections in force today. */
  elections: HrTaxElection[];
  /**
   * Which election kinds (and states) the employee still has to sign: anything
   * with an election in force is left out. State codes are upper case.
   */
  requiredElections: HrRequiredElection[];
  /**
   * Fields payroll still needs, only those relevant to the employee's country.
   * Codes: `nationalId`, `dateOfBirth`, `bankIban`, `bankBic`, `bankRoutingNumber`,
   * `bankAccountNumber`, `bankAccountType`, `homeAddress`, `idDocument`.
   * NL asks for nationalId, dateOfBirth, bankIban and idDocument; US for nationalId,
   * bankRoutingNumber, bankAccountNumber, bankAccountType and homeAddress. (`bankBic`
   * is never required today: SEPA salary batches do not need it.)
   */
  missing: string[];
}

/** A state's withholding certificate (DE 4, IT-2104, …): what to render so the employee can fill it in. */
export interface HrStateCertificateDefinition {
  formName: string;
  filingStatuses?: string[];
  usesAllowances: boolean;
  fields: Array<{
    key: string;
    type: 'select' | 'number' | 'money' | 'boolean';
    options?: string[];
    required?: boolean;
    /** Translation key under `weldhr.payroll.stateCertificates.<state>.<key>`. */
    labelKey: string;
  }>;
}

export interface HrRequiredElection {
  kind: HrTaxElectionKind;
  /** Upper-case state code for `us_state_certificate`, else null. */
  state: string | null;
  /** For `us_state_certificate`: the state's certificate definition, so clients need not import the domain package. */
  certificate?: HrStateCertificateDefinition | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const base = '/weldhr/payroll';
const me = '/weldhr/me';

function qs(params: object): string {
  return buildQueryString(params as Record<string, unknown>);
}

export function createWeldHrPayrollApi(api: ClientApi) {
  return {
    overview(): Promise<DataResponse<HrPayrollOverview>> {
      return api.get(`${base}/overview`);
    },

    // Employers --------------------------------------------------------------
    listEmployers(): Promise<DataResponse<HrPayrollEmployer[]>> {
      return api.get(`${base}/employers`);
    },
    getEmployer(id: string): Promise<DataResponse<HrPayrollEmployer>> {
      return api.get(`${base}/employers/${id}`);
    },
    createEmployer(body: CreateHrPayrollEmployerInput): Promise<DataResponse<HrPayrollEmployer>> {
      return api.post(`${base}/employers`, body);
    },
    updateEmployer(id: string, body: UpdateHrPayrollEmployerInput): Promise<DataResponse<HrPayrollEmployer>> {
      return api.patch(`${base}/employers/${id}`, body);
    },
    deleteEmployer(id: string): Promise<void> {
      return api.delete(`${base}/employers/${id}`);
    },
    setEmployerBank(id: string, body: HrPayrollEmployerBankInput): Promise<DataResponse<HrPayrollEmployer>> {
      return api.put(`${base}/employers/${id}/bank`, body);
    },

    // Schedules --------------------------------------------------------------
    listSchedules(params: { employerId?: string } = {}): Promise<DataResponse<HrPaySchedule[]>> {
      return api.get(`${base}/schedules${qs(params)}`);
    },
    createSchedule(body: CreateHrPayScheduleInput): Promise<DataResponse<HrPaySchedule>> {
      return api.post(`${base}/schedules`, body);
    },
    updateSchedule(id: string, body: UpdateHrPayScheduleInput): Promise<DataResponse<HrPaySchedule>> {
      return api.patch(`${base}/schedules/${id}`, body);
    },
    deleteSchedule(id: string): Promise<void> {
      return api.delete(`${base}/schedules/${id}`);
    },

    // Employees --------------------------------------------------------------
    listEmployees(params: { employerId?: string; onPayroll?: boolean } = {}): Promise<DataResponse<HrPayrollEmployeeListItem[]>> {
      return api.get(`${base}/employees${qs(params)}`);
    },
    getEmployee(employeeId: string): Promise<DataResponse<HrPayrollEmployeeDetail>> {
      return api.get(`${base}/employees/${employeeId}`);
    },
    upsertProfile(employeeId: string, body: UpsertHrPayrollProfileInput): Promise<DataResponse<HrPayrollProfile>> {
      return api.put(`${base}/employees/${employeeId}/profile`, body);
    },
    setPaymentDetails(employeeId: string, body: HrPayrollPaymentDetailsInput): Promise<DataResponse<HrPayrollPaymentDetailsMasked>> {
      return api.put(`${base}/employees/${employeeId}/payment-details`, body);
    },
    createCompensation(employeeId: string, body: CreateHrCompensationInput): Promise<DataResponse<HrCompensation>> {
      return api.post(`${base}/employees/${employeeId}/compensations`, body);
    },
    deleteCompensation(id: string): Promise<void> {
      return api.delete(`${base}/compensations/${id}`);
    },
    createComponent(employeeId: string, body: CreateHrPayComponentInput): Promise<DataResponse<HrPayComponent>> {
      return api.post(`${base}/employees/${employeeId}/components`, body);
    },
    updateComponent(id: string, body: UpdateHrPayComponentInput): Promise<DataResponse<HrPayComponent>> {
      return api.patch(`${base}/components/${id}`, body);
    },
    deleteComponent(id: string): Promise<void> {
      return api.delete(`${base}/components/${id}`);
    },
    listTaxElections(employeeId: string): Promise<DataResponse<HrTaxElection[]>> {
      return api.get(`${base}/employees/${employeeId}/tax-elections`);
    },
    createTaxElection(employeeId: string, body: CreateHrTaxElectionInput): Promise<DataResponse<HrTaxElection>> {
      return api.post(`${base}/employees/${employeeId}/tax-elections`, body);
    },
    listEmployeePayslips(employeeId: string): Promise<DataResponse<HrPayslipSummary[]>> {
      return api.get(`${base}/employees/${employeeId}/payslips`);
    },
    listAnnualStatements(employeeId: string): Promise<DataResponse<HrAnnualStatement[]>> {
      return api.get(`${base}/employees/${employeeId}/annual-statements`);
    },
    /** PDF; the caller reads it as a blob. */
    annualStatementPdf(employeeId: string, year: number, employerId: string): Promise<Response> {
      return api.getRaw(`${base}/employees/${employeeId}/annual-statements/${year}${qs({ employerId })}`);
    },

    // Pay runs ---------------------------------------------------------------
    listRuns(params: { employerId?: string; status?: string; year?: number } = {}): Promise<DataResponse<HrPayRun[]>> {
      return api.get(`${base}/runs${qs(params)}`);
    },
    getRun(id: string): Promise<DataResponse<HrPayRunDetail>> {
      return api.get(`${base}/runs/${id}`);
    },
    createRun(body: CreateHrPayRunInput): Promise<DataResponse<HrPayRunDetail>> {
      return api.post(`${base}/runs`, body);
    },
    updateRun(id: string, body: UpdateHrPayRunInput): Promise<DataResponse<HrPayRunDetail>> {
      return api.patch(`${base}/runs/${id}`, body);
    },
    /** Cancels a draft or calculated run. */
    cancelRun(id: string): Promise<DataResponse<HrPayRunDetail>> {
      return api.post(`${base}/runs/${id}/cancel`, {});
    },
    setRunEmployee(id: string, body: SetHrPayRunEmployeeInput): Promise<DataResponse<HrPayRunDetail>> {
      return api.post(`${base}/runs/${id}/employees`, body);
    },
    /** Re-collects hours, leave and approved expenses into the run's inputs. */
    collectRunInputs(id: string): Promise<DataResponse<HrPayRunDetail>> {
      return api.post(`${base}/runs/${id}/collect`, {});
    },
    listRunInputs(id: string, params: { employeeId?: string } = {}): Promise<DataResponse<HrPayRunInput[]>> {
      return api.get(`${base}/runs/${id}/inputs${qs(params)}`);
    },
    createRunInput(id: string, body: CreateHrPayRunInputInput): Promise<DataResponse<HrPayRunInput>> {
      return api.post(`${base}/runs/${id}/inputs`, body);
    },
    updateRunInput(id: string, inputId: string, body: UpdateHrPayRunInputInput): Promise<DataResponse<HrPayRunInput>> {
      return api.patch(`${base}/runs/${id}/inputs/${inputId}`, body);
    },
    deleteRunInput(id: string, inputId: string): Promise<void> {
      return api.delete(`${base}/runs/${id}/inputs/${inputId}`);
    },
    calculateRun(id: string): Promise<DataResponse<HrPayRunDetail>> {
      return api.post(`${base}/runs/${id}/calculate`, {});
    },
    approveRun(id: string): Promise<DataResponse<HrPayRunDetail>> {
      return api.post(`${base}/runs/${id}/approve`, {});
    },
    markRunPaid(id: string, body: MarkHrPayRunPaidInput = {}): Promise<DataResponse<HrPayRunDetail>> {
      return api.post(`${base}/runs/${id}/mark-paid`, body);
    },
    /** Retry the WeldBooks journal of an approved run. */
    postRunJournal(id: string): Promise<DataResponse<HrPayRunDetail>> {
      return api.post(`${base}/runs/${id}/post-journal`, {});
    },
    /** SEPA pain.001 (NL) or NACHA (US) file; the caller reads it as a blob. */
    runPaymentFile(id: string): Promise<Response> {
      return api.getRaw(`${base}/runs/${id}/payment-file`);
    },
    /** CSV of every payslip line in the run. */
    runReport(id: string): Promise<Response> {
      return api.getRaw(`${base}/runs/${id}/report`);
    },

    // Payslips ---------------------------------------------------------------
    getPayslip(id: string): Promise<DataResponse<HrPayslip>> {
      return api.get(`${base}/payslips/${id}`);
    },
    /** PDF (a draft payslip renders with a "draft" watermark). */
    payslipPdf(id: string): Promise<Response> {
      return api.getRaw(`${base}/payslips/${id}/pdf`);
    },

    // Filings ----------------------------------------------------------------
    listFilings(params: { employerId?: string; year?: number; status?: string; kind?: string } = {}): Promise<DataResponse<HrPayrollFiling[]>> {
      return api.get(`${base}/filings${qs(params)}`);
    },
    getFiling(id: string): Promise<DataResponse<HrPayrollFiling>> {
      return api.get(`${base}/filings/${id}`);
    },
    /** Rebuild the filing from final payslips. */
    generateFiling(id: string): Promise<DataResponse<HrPayrollFiling>> {
      return api.post(`${base}/filings/${id}/generate`, {});
    },
    filingFile(id: string): Promise<Response> {
      return api.getRaw(`${base}/filings/${id}/file`);
    },
    /** NL: send the loonaangifte over Digipoort. */
    submitFiling(id: string): Promise<DataResponse<HrPayrollFiling>> {
      return api.post(`${base}/filings/${id}/submit`, {});
    },
    refreshFilingStatus(id: string): Promise<DataResponse<HrPayrollFiling>> {
      return api.post(`${base}/filings/${id}/refresh-status`, {});
    },
    markFilingFiled(id: string, body: MarkHrPayrollFilingFiledInput = {}): Promise<DataResponse<HrPayrollFiling>> {
      return api.post(`${base}/filings/${id}/mark-filed`, body);
    },

    // My HR (the signed-in employee) ----------------------------------------
    myPayslips(): Promise<DataResponse<HrMyPayslip[]>> {
      return api.get(`${me}/payslips`);
    },
    myPayslipPdf(id: string): Promise<Response> {
      return api.getRaw(`${me}/payslips/${id}/pdf`);
    },
    myAnnualStatements(): Promise<DataResponse<HrAnnualStatement[]>> {
      return api.get(`${me}/annual-statements`);
    },
    myAnnualStatementPdf(year: number, employerId: string): Promise<Response> {
      return api.getRaw(`${me}/annual-statements/${year}${qs({ employerId })}`);
    },
    myPayrollDetails(): Promise<DataResponse<HrMyPayrollDetails>> {
      return api.get(`${me}/payroll-details`);
    },
    updateMyPayrollDetails(body: HrPayrollPaymentDetailsInput): Promise<DataResponse<HrMyPayrollDetails>> {
      return api.put(`${me}/payroll-details`, body);
    },
    signMyTaxElection(body: CreateHrTaxElectionInput): Promise<DataResponse<HrMyPayrollDetails>> {
      return api.post(`${me}/tax-elections`, body);
    },
  };
}

export type WeldHrPayrollApi = ReturnType<typeof createWeldHrPayrollApi>;
