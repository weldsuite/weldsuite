/**
 * NACHA (ACH) file of PPD credits for US direct deposit: the employer uploads
 * it to its own bank. WeldSuite never moves the money.
 *
 * Placeholder: the signatures are the contract hr-api codes against; the
 * implementation lands with the US engine.
 */

import type { GeneratedFile } from './documents';
import type { PayrollIssue } from './types';

export interface NachaOriginator {
  /** Company name as the bank knows it (max 16). */
  companyName: string;
  /** Company identification the bank assigned, 10 chars (often `1` + EIN). */
  companyId: string;
  /** The employer's bank (ODFI) routing number, 9 digits. */
  odfiRouting: string;
  /** The ODFI's name for the file header (max 23). */
  odfiName: string;
}

export interface NachaCredit {
  /** Employee number or payslip id (max 15). */
  individualId: string;
  /** Max 22. */
  individualName: string;
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  amountCents: number;
}

export interface NachaFileInput {
  originator: NachaOriginator;
  /** Settlement date, `YYYY-MM-DD`. */
  effectiveDate: string;
  /** ISO date-time the file was created. */
  createdAt: string;
  /** A–Z / 0–9, distinguishes files created the same day. */
  fileIdModifier?: string;
  /** Batch entry description (max 10), default `PAYROLL`. */
  entryDescription?: string;
  credits: NachaCredit[];
  /** Some banks want a balanced file: one offsetting debit from the employer's account. */
  balancedOffset?: { routingNumber: string; accountNumber: string; accountType: 'checking' | 'savings' } | null;
}

export function buildNachaFile(_input: NachaFileInput): GeneratedFile & { issues: PayrollIssue[] } {
  throw new Error('NACHA file is not implemented yet');
}

export function isValidRoutingNumber(_routingNumber: string): boolean {
  throw new Error('Routing number validation is not implemented yet');
}
