/**
 * Payroll self-service shapes served by `/public/hr-portal/employee/{payslips,
 * annual-statements,payroll-details,tax-elections}`.
 *
 * Local copies, like `lib/types.ts`: this app does not depend on
 * `@weldsuite/app-api-client`. They mirror
 * `packages/clients/app-api-client/src/domains/weldhr-payroll.ts` (responses)
 * and `src/schemas/weldhr-payroll.ts` (`hrPayrollPaymentDetailsSchema`,
 * `createHrTaxElectionSchema`, requests). Change them together.
 *
 * Amounts that are stored come back as decimal strings (`"2750.50"`).
 * Identifiers and bank numbers only ever come back masked; they are
 * write-only through the API.
 */

export type HrPayrollCountry = 'NL' | 'US';
export type HrTaxElectionKind = 'nl_loonheffingskorting' | 'us_w4' | 'us_state_certificate';

export interface HrPayrollAddress {
  line1?: string | null;
  line2?: string | null;
  houseNumber?: string | null;
  houseNumberAddition?: string | null;
  postalCode?: string | null;
  city?: string | null;
  region?: string | null;
  /** ISO 3166-1 alpha-2. */
  country?: string | null;
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

export type HrIdDocumentType = 'passport' | 'id_card' | 'residence_permit' | 'drivers_license';
export type HrBankAccountType = 'checking' | 'savings';

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
  bankAccountType: HrBankAccountType | null;
  homeAddress: HrPayrollAddress | null;
  idDocumentType: HrIdDocumentType | null;
  idDocumentExpiresOn: string | null;
  idVerifiedAt: string | null;
}

export interface HrMyPayslip {
  id: string;
  number: string | null;
  employerName: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  /** Decimal string. */
  grossPay: string;
  /** Decimal string. */
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
  /** Which election kinds (and states) the employee still has to sign. */
  requiredElections: Array<{ kind: HrTaxElectionKind; state: string | null }>;
  /** Fields payroll still needs (`nationalId`, `bankIban`, `dateOfBirth`, …). */
  missing: string[];
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Body of `PUT /employee/payroll-details` (`hrPayrollPaymentDetailsSchema`
 * without `idVerifiedAt`, which only HR can set). A key left out keeps the
 * stored value; `null` clears it.
 */
export interface HrPayrollPaymentDetailsInput {
  nationalId?: string | null;
  dateOfBirth?: string | null;
  bankAccountHolder?: string | null;
  bankIban?: string | null;
  bankBic?: string | null;
  bankRoutingNumber?: string | null;
  bankAccountNumber?: string | null;
  bankAccountType?: HrBankAccountType | null;
  homeAddress?: HrPayrollAddress | null;
  idDocumentType?: HrIdDocumentType | null;
  idDocumentNumber?: string | null;
  idDocumentExpiresOn?: string | null;
}

export type HrUsFilingStatus = 'single' | 'married_jointly' | 'head_of_household';

export interface HrUsW4Data {
  formYear: number;
  filingStatus: HrUsFilingStatus;
  multipleJobs: boolean;
  dependentsAmount: number;
  otherIncome: number;
  deductions: number;
  extraWithholding: number;
  exempt: boolean;
  allowances?: number | null;
  nonresidentAlien?: boolean;
}

export interface HrUsStateCertificateData {
  filingStatus?: string | null;
  allowances?: number | null;
  values?: Record<string, number | string | boolean | null>;
  extraWithholding?: number | null;
  exempt?: boolean;
}

/** Body of `POST /employee/tax-elections` (`createHrTaxElectionSchema`). */
export type CreateHrTaxElectionInput =
  | {
      kind: 'nl_loonheffingskorting';
      effectiveFrom: string;
      data: { applyCredit: boolean };
      signatureName: string;
    }
  | {
      kind: 'us_w4';
      effectiveFrom: string;
      data: HrUsW4Data;
      signatureName: string;
    }
  | {
      kind: 'us_state_certificate';
      state: string;
      effectiveFrom: string;
      data: HrUsStateCertificateData;
      signatureName: string;
    };
