/**
 * US federal and state filings built from final payslips: Form 941 per
 * quarter, Form 940 and W-2/W-3 per year, and state withholding and
 * unemployment wage reports per quarter. WeldSuite prepares them; the
 * employer files and pays (self-service model, docs/plans/weldhr-payroll.md).
 *
 * Placeholder: the signatures are the contract hr-api codes against; the
 * implementation lands with the US engine.
 */

import type { GeneratedFile, PayrollDocument } from '../documents';
import type { UsFilingData } from '../types';

export interface UsPayslipForForms {
  payslipId: string;
  employeeId: string;
  payDate: string;
  filingData: UsFilingData;
}

export interface UsEmployerForForms {
  name: string;
  ein: string | null;
  address: string[];
  depositSchedule: 'monthly' | 'semiweekly';
  states: Record<string, { withholdingAccountNumber?: string | null; suiAccountNumber?: string | null }>;
}

export interface UsEmployeeForForms {
  employeeId: string;
  name: string;
  /** Full SSN for the employer's copy; masked for anything shown in the UI. */
  ssn: string | null;
  address: string[];
}

export interface UsFormResult {
  /** Lines of the form in cents, e.g. `line2`, `line5a_wages`, `box1`. */
  summary: Record<string, number>;
  /** Balance due with the return (after deposits are taken as made on time), cents. */
  amountDueCents: number;
  dueDate: string;
  document: PayrollDocument;
  files?: GeneratedFile[];
}

export function form941(_input: {
  employer: UsEmployerForForms;
  taxYear: number;
  quarter: 1 | 2 | 3 | 4;
  payslips: UsPayslipForForms[];
}): UsFormResult {
  throw new Error('Form 941 is not implemented yet');
}

export function form940(_input: { employer: UsEmployerForForms; taxYear: number; payslips: UsPayslipForForms[] }): UsFormResult {
  throw new Error('Form 940 is not implemented yet');
}

export function formW2(_input: {
  employer: UsEmployerForForms;
  employee: UsEmployeeForForms;
  taxYear: number;
  payslips: UsPayslipForForms[];
}): UsFormResult {
  throw new Error('Form W-2 is not implemented yet');
}

export function formW3(_input: {
  employer: UsEmployerForForms;
  taxYear: number;
  employees: Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }>;
}): UsFormResult {
  throw new Error('Form W-3 is not implemented yet');
}

export function stateWithholdingReport(_input: {
  employer: UsEmployerForForms;
  state: string;
  taxYear: number;
  quarter: 1 | 2 | 3 | 4;
  employees: Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }>;
}): UsFormResult {
  throw new Error('State withholding report is not implemented yet');
}

export function stateUnemploymentReport(_input: {
  employer: UsEmployerForForms;
  state: string;
  taxYear: number;
  quarter: 1 | 2 | 3 | 4;
  employees: Array<{ employee: UsEmployeeForForms; payslips: UsPayslipForForms[] }>;
}): UsFormResult {
  throw new Error('State unemployment report is not implemented yet');
}

/** When the federal deposit for wages paid on `payDate` is due. */
export function depositDueDate(_schedule: 'monthly' | 'semiweekly', _payDate: string): string {
  throw new Error('Deposit schedule is not implemented yet');
}
