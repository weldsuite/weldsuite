/**
 * What the payroll services depend on that is not the database: the engines
 * and builders of @weldsuite/payroll-domain, the PDF renderer, R2, the
 * WeldBooks bridge, the usage meter, the Digipoort gateway.
 *
 * Services take a `PayrollDeps`, so the route builds the real thing from the
 * request (`routes/weldhr/payroll/deps.ts`) and tests pass fakes. The engines
 * are the part other packages implement independently; a test injects a fake
 * engine and never depends on their state.
 */

import type { EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { calculatePayslip } from '@weldsuite/payroll-domain';
import type { PayrollDocument } from '@weldsuite/payroll-domain/documents';
import { buildNachaFile } from '@weldsuite/payroll-domain/nacha';
import { nlAnnualStatement } from '@weldsuite/payroll-domain/nl/annual-statement';
import {
  betalingskenmerk,
  buildLoonaangifte,
  loonaangifteDueDate,
  loonaangifteSummaryDocument,
  sumNlFilingData,
} from '@weldsuite/payroll-domain/nl/loonaangifte';
import { renderDocumentPdf, renderPayslipPdf, type PayslipView } from '@weldsuite/payroll-domain/payslip-pdf';
import { buildSepaSalaryBatch } from '@weldsuite/payroll-domain/sepa';
import {
  depositDueDate,
  form940,
  form941,
  formW2,
  formW3,
  stateUnemploymentReport,
  stateWithholdingReport,
} from '@weldsuite/payroll-domain/us/forms';

export interface PayrollEngines {
  calculatePayslip: typeof calculatePayslip;
  buildSepaSalaryBatch: typeof buildSepaSalaryBatch;
  buildNachaFile: typeof buildNachaFile;
  buildLoonaangifte: typeof buildLoonaangifte;
  sumNlFilingData: typeof sumNlFilingData;
  loonaangifteDueDate: typeof loonaangifteDueDate;
  loonaangifteSummaryDocument: typeof loonaangifteSummaryDocument;
  nlAnnualStatement: typeof nlAnnualStatement;
  form941: typeof form941;
  form940: typeof form940;
  formW2: typeof formW2;
  formW3: typeof formW3;
  stateWithholdingReport: typeof stateWithholdingReport;
  stateUnemploymentReport: typeof stateUnemploymentReport;
  depositDueDate: typeof depositDueDate;
  /**
   * The betalingskenmerk of a monthly loonheffingen payment: the filing's
   * `paymentReference`, and what lets the SEPA batch carry the tax payment.
   */
  paymentReference?: (args: { loonheffingennummer: string; taxYear: number; month: number }) => string | null;
}

export const defaultEngines: PayrollEngines = {
  calculatePayslip,
  buildSepaSalaryBatch,
  buildNachaFile,
  buildLoonaangifte,
  sumNlFilingData,
  loonaangifteDueDate,
  loonaangifteSummaryDocument,
  nlAnnualStatement,
  form941,
  form940,
  formW2,
  formW3,
  stateWithholdingReport,
  stateUnemploymentReport,
  depositDueDate,
  paymentReference: betalingskenmerk,
};

export interface PayrollPdf {
  payslip(view: PayslipView, lang: 'en' | 'nl'): Promise<Uint8Array>;
  document(doc: PayrollDocument): Promise<Uint8Array>;
}

export const defaultPdf: PayrollPdf = {
  payslip: renderPayslipPdf,
  document: renderDocumentPdf,
};

// ---------------------------------------------------------------------------
// WeldBooks bridge
// ---------------------------------------------------------------------------

/** What the payroll journal posts, in currency units (decimals). Signed: a correction run can be negative. */
export interface JournalTotals {
  grossWages: number;
  employerTaxes: number;
  employerBenefits: number;
  reimbursements: number;
  employeeTaxes: number;
  employeeDeductions: number;
  /** Net pay excluding reimbursements, so gross = net + employee taxes + employee deductions holds by construction. */
  netPay: number;
}

export interface BooksPayrollPost {
  entityId: string;
  /** The pay run id: books-api posts a payroll once per (entity, source, externalId). */
  externalId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  description: string;
  country: 'NL' | 'US';
  totals: JournalTotals;
  postedBy: string | null;
}

export type BooksPayrollResult =
  | { status: 'posted'; importId: string; journalEntryId: string | null; duplicate: boolean }
  | { status: 'failed'; error: string };

export interface BooksBridge {
  postPayroll(workspaceKey: string, input: BooksPayrollPost): Promise<BooksPayrollResult>;
}

/** The `BOOKS_INTERNAL` service binding (entrypoint `BooksInternal`) as a bridge. Null without the binding. */
export function createBooksBridge(binding: Fetcher | undefined | null): BooksBridge | null {
  if (!binding) return null;
  return {
    async postPayroll(workspaceKey, input) {
      try {
        const response = await binding.fetch('https://internal/internal/payroll/imports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceKey },
          body: JSON.stringify(input),
        });
        const body = (await response.json().catch(() => null)) as {
          data?: { importId?: string; journalEntryId?: string | null; duplicate?: boolean; status?: string };
          error?: { message?: string };
        } | null;
        if (!response.ok || !body?.data?.importId) {
          return { status: 'failed', error: body?.error?.message ?? `books-api answered ${response.status}` };
        }
        // books-api answers a reversed payroll with a 409; an older deployment answers 200 with the import's status.
        if (body.data.status === 'reversed') return { status: 'failed', error: 'This payroll was posted to WeldBooks and has since been reversed there.' };
        return {
          status: 'posted',
          importId: body.data.importId,
          journalEntryId: body.data.journalEntryId ?? null,
          duplicate: body.data.duplicate === true,
        };
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Usage metering, Digipoort, notifications
// ---------------------------------------------------------------------------

export interface UsageEventInput {
  workspaceId: string;
  /** `YYYY-MM` of the pay date. */
  month: string;
  country: 'NL' | 'US';
  employerId: string;
  runId: string;
  payslipId: string;
}

/** Writes billable usage; must be idempotent per payslip (the table's unique index). */
export type UsageMeter = (events: UsageEventInput[]) => Promise<void>;

export interface DigipoortGateway {
  submit(input: { xml: string; fileName: string; loonheffingennummer: string; messageId: string }): Promise<{ reference: string }>;
  status(reference: string): Promise<{ status: 'submitted' | 'accepted' | 'rejected'; message?: string | null }>;
}

export interface PayrollNotifier {
  /** The employee's payslip is ready (portal access or a linked member). Best effort. */
  payslipReady?(args: { employeeId: string; email: string; name: string; payDate: string; employerName: string; lang: 'en' | 'nl' }): Promise<void>;
  /** Bank details changed: tell the employee, because changed bank details are the classic payroll fraud. */
  bankChanged?(args: { employeeId: string; email: string; name: string; employerName: string; byEmployee: boolean; lang: 'en' | 'nl' }): Promise<void>;
}

export interface PayrollDeps {
  engines: PayrollEngines;
  pdf: PayrollPdf;
  keyring: EncryptionKeyring;
  /** R2 bucket for payslip and filing files. Null (tests, missing binding): files are rendered on demand, not stored. */
  bucket: R2Bucket | null;
  /** Prefix key of the workspace in R2 (`workspaces/<workspaceKey>/hr/…`): the same id the receipts use. */
  workspaceKey: string;
  /** The id the billing ledger uses (master workspace id); resolved lazily because only approval needs it. */
  usageWorkspaceId: () => Promise<string>;
  books: BooksBridge | null;
  meter: UsageMeter | null;
  /** Null when Digipoort is not configured (no certificate binding / secrets). */
  digipoort: DigipoortGateway | null;
  /** WeldSuite's ODB relatienummer as software developer (`SWO12345`), written into every loonaangifte. */
  nlSoftwareRelationNumber?: string | null;
  notifier: PayrollNotifier | null;
  now: () => Date;
}

/** Deps for tests and scripts: the default engines and PDF renderer, nothing external. */
export function basicDeps(overrides: Partial<PayrollDeps> & Pick<PayrollDeps, 'keyring'>): PayrollDeps {
  return {
    engines: defaultEngines,
    pdf: defaultPdf,
    bucket: null,
    workspaceKey: 'org_test',
    usageWorkspaceId: async () => 'ws_test',
    books: null,
    meter: null,
    digipoort: null,
    notifier: null,
    now: () => new Date(),
    ...overrides,
  };
}
