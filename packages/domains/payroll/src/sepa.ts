/**
 * SEPA salary batch (ISO 20022 pain.001, category purpose SALA) for Dutch
 * payroll: the employer uploads it to its own bank. Optionally carries the
 * loonheffingen payment to the Belastingdienst with its betalingskenmerk.
 *
 * Placeholder: the signatures are the contract hr-api codes against; the
 * implementation lands with the NL engine.
 */

import type { GeneratedFile } from './documents';
import type { PayrollIssue } from './types';

export interface SepaParty {
  name: string;
  iban: string;
  bic?: string | null;
}

export interface SepaSalaryPayment {
  /** Unique per payment, max 35 chars (the payslip id works). */
  endToEndId: string;
  creditor: SepaParty;
  amountCents: number;
  /** Unstructured remittance, max 140 chars ("Salaris april 2026"). */
  remittance: string;
}

export interface SepaTaxPayment {
  amountCents: number;
  /** The period's betalingskenmerk (structured remittance). */
  betalingskenmerk: string;
  /** Defaults to the Belastingdienst's account. */
  creditor?: SepaParty;
}

export interface SepaSalaryBatchInput {
  /** Unique per file, max 35 chars. */
  messageId: string;
  /** ISO date-time the file was created. */
  createdAt: string;
  /** Requested execution date, `YYYY-MM-DD`. */
  executionDate: string;
  debtor: SepaParty;
  salaries: SepaSalaryPayment[];
  tax?: SepaTaxPayment | null;
}

export function buildSepaSalaryBatch(_input: SepaSalaryBatchInput): GeneratedFile & { issues: PayrollIssue[] } {
  throw new Error('SEPA salary batch is not implemented yet');
}

export function isValidIban(_iban: string): boolean {
  throw new Error('IBAN validation is not implemented yet');
}
