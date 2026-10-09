/**
 * The Dutch payroll tax return (aangifte loonheffingen) for one employer and
 * one period, as the Belastingdienst's XML message.
 *
 * Placeholder: the signatures are the contract hr-api codes against; the
 * implementation lands with the NL engine.
 */

import type { GeneratedFile, PayrollDocument } from '../documents';
import type { NlFilingData, PayrollIssue } from '../types';

export interface NlEmployeeIdentity {
  /** BSN; null only for an anonymous employee. */
  bsn: string | null;
  /** `J.M.` */
  initials: string;
  surnamePrefix: string | null;
  surname: string;
  dateOfBirth: string | null;
  /** ISO 3166-1 alpha-2. */
  nationality: string | null;
  /** 1 male, 2 female, 0 unknown. */
  gender: 0 | 1 | 2 | null;
  /** Needed when there is no BSN. */
  address?: {
    street?: string | null;
    houseNumber?: string | null;
    houseNumberAddition?: string | null;
    postalCode?: string | null;
    city?: string | null;
    country?: string | null;
  } | null;
  personnelNumber?: string | null;
}

/** One income relationship in the return, with its figures for the period. */
export interface LoonaangifteIkv {
  identity: NlEmployeeIdentity;
  incomeRelationshipNumber: number;
  employmentStart: string;
  employmentEnd: string | null;
  /** The period's payslips summed (`sumNlFilingData`). */
  filing: NlFilingData;
}

export interface LoonaangifteInput {
  employer: {
    loonheffingennummer: string;
    name: string;
    contactName: string | null;
    contactPhone: string | null;
  };
  software: { name: string; version: string };
  taxYear: number;
  period: { start: string; end: string };
  ikvs: LoonaangifteIkv[];
  /** Earlier periods of the same year that changed since they were filed: full replacement per period. */
  corrections: Array<{ period: { start: string; end: string }; ikvs: LoonaangifteIkv[] }>;
  /** ISO date-time. */
  createdAt: string;
  /** Unique message id for this submission. */
  messageId: string;
}

export interface LoonaangifteResult {
  file: GeneratedFile;
  /** Totals of the return in cents, keyed by the spec's element names. */
  summary: Record<string, number>;
  /** What the employer pays for this return (including corrections), cents. */
  amountDueCents: number;
  issues: PayrollIssue[];
}

export function buildLoonaangifte(_input: LoonaangifteInput): LoonaangifteResult {
  throw new Error('Loonaangifte is not implemented yet');
}

/** Add up several payslips' filing data for one income relationship and period. */
export function sumNlFilingData(_items: NlFilingData[]): NlFilingData {
  throw new Error('Loonaangifte is not implemented yet');
}

/** Filing and payment deadline of a monthly return. */
export function loonaangifteDueDate(_taxYear: number, _month: number): string {
  throw new Error('Loonaangifte is not implemented yet');
}

/** A printable summary of the return (totals per premium and tax). */
export function loonaangifteSummaryDocument(
  _result: LoonaangifteResult,
  _input: LoonaangifteInput,
  _lang: 'en' | 'nl',
): PayrollDocument {
  throw new Error('Loonaangifte is not implemented yet');
}
