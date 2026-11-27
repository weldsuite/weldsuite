/**
 * The "Book to a category" rows of the processing view: a line is booked to
 * one category, or split over several. The rows add up to the bank line's
 * absolute amount (tax-inclusive); the model says what is left and builds the
 * `POST /bank-transactions/{id}/categorize` body. Pure functions.
 */

import { fromCents, toCents } from '@/lib/weldbooks/bank-link-math';
import type { CategorizeInput, CategorizeLineInput } from '@/lib/api/domains/weldbooks-processing';

/** The server takes 1 to 100 rows. */
export const MAX_SPLIT_ROWS = 100;

export interface SplitRow {
  /** Stable id for React keys; never sent. */
  key: string;
  accountId: string;
  taxRateId: string;
  contactId: string;
  projectId: string;
  /** As typed. */
  amount: string;
}

export type SplitProblem = 'noCategory' | 'badAmount' | 'notBalanced' | 'tooMany';

let counter = 0;

export function newSplitRow(amount = '', defaults: Partial<SplitRow> = {}): SplitRow {
  counter += 1;
  return { key: `row-${counter}`, accountId: '', taxRateId: '', contactId: '', projectId: '', amount, ...defaults };
}

/** The line's absolute amount in cents. */
export function lineCents(lineAmount: string | number): number {
  const cents = toCents(lineAmount);
  return Number.isFinite(cents) ? Math.abs(cents) : 0;
}

/** What the rows still have to take to reach the line: positive = left to book, negative = over. */
export function remainderCents(lineAmount: string | number, rows: readonly SplitRow[]): number {
  const booked = rows.reduce((sum, row) => {
    const cents = toCents(row.amount);
    return sum + (Number.isFinite(cents) ? cents : 0);
  }, 0);
  return lineCents(lineAmount) - booked;
}

/** The first thing wrong with the rows, or null when they can be booked. */
export function splitProblem(lineAmount: string | number, rows: readonly SplitRow[]): SplitProblem | null {
  if (rows.length === 0 || rows.length > MAX_SPLIT_ROWS) return 'tooMany';
  for (const row of rows) {
    const cents = toCents(row.amount);
    if (!Number.isFinite(cents) || cents <= 0) return 'badAmount';
  }
  if (rows.some((row) => !row.accountId)) return 'noCategory';
  return remainderCents(lineAmount, rows) === 0 ? null : 'notBalanced';
}

/** The request body for rows that passed `splitProblem`. Empty optional ids are left out. */
export function buildCategorizeInput(rows: readonly SplitRow[]): CategorizeInput {
  const lines = rows.map((row): CategorizeLineInput => {
    const line: CategorizeLineInput = { accountId: row.accountId, amount: fromCents(toCents(row.amount)) };
    if (row.taxRateId) line.taxRateId = row.taxRateId;
    if (row.contactId) line.contactId = row.contactId;
    if (row.projectId) line.projectId = row.projectId;
    return line;
  });
  return { lines };
}

/** A new row after the last one starts with whatever is left to book (never below zero). */
export function nextRowAmount(lineAmount: string | number, rows: readonly SplitRow[]): string {
  const left = remainderCents(lineAmount, rows);
  return left > 0 ? fromCents(left) : '';
}
