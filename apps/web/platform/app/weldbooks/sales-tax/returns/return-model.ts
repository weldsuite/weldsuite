/**
 * The logic of the return screen that has no UI: which step of the flow a
 * status is at, the adjustments editor's draft rows and their payload, the
 * total due, the payment rules and the reading of the server's check output.
 */
import {
  isSalesTaxRequestError,
  type AdjustmentType,
  type ReturnAdjustment,
  type ReturnSummary,
} from '@/lib/api/domains/weldbooks-sales-tax-center';
import { sameAmount, toCents } from '../shared/text';

// ============================================================================
// Steps
// ============================================================================

export const RETURN_STEPS = ['calculate', 'review', 'preFile', 'file', 'pay'] as const;
export type ReturnStep = (typeof RETURN_STEPS)[number];
export type StepState = 'done' | 'current' | 'todo';

/**
 * Where a return is in the flow. The pre-file check has no status of its own:
 * it counts as done once the return is filed, or once it was reviewed and the
 * check found nothing.
 */
export function stepStates(status: string, preFileOk = false): Record<ReturnStep, StepState> {
  const calculated = status !== 'open';
  const reviewed = status === 'reviewed' || status === 'filed' || status === 'paid';
  const filed = status === 'filed' || status === 'paid';
  const done: Record<ReturnStep, boolean> = {
    calculate: calculated,
    review: reviewed,
    preFile: filed || (reviewed && preFileOk),
    file: filed,
    pay: status === 'paid',
  };
  const currentStep = RETURN_STEPS.find((step) => !done[step]);
  return Object.fromEntries(
    RETURN_STEPS.map((step) => [step, done[step] ? 'done' : step === currentStep ? 'current' : 'todo']),
  ) as Record<ReturnStep, StepState>;
}

// ============================================================================
// Adjustments
// ============================================================================

/** One row of the adjustments editor: the amount is the text the user typed. */
export interface AdjustmentDraft {
  id: string;
  type: AdjustmentType;
  amount: string;
  note: string;
  /** `other` adjustments: the ledger account they post to; empty for the agency's payable. */
  accountId: string;
  /** A proposal the server refreshes on every calculation: any edit makes it the user's own. */
  auto: boolean;
}

let draftCounter = 0;

export function newDraftId(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

export function emptyDraft(type: AdjustmentType = 'penalty'): AdjustmentDraft {
  return { id: newDraftId(), type, amount: '', note: '', accountId: '', auto: false };
}

export function draftsFromAdjustments(adjustments: readonly ReturnAdjustment[] | null | undefined): AdjustmentDraft[] {
  return (adjustments ?? []).map((adjustment) => ({
    id: newDraftId(),
    type: adjustment.type,
    amount: String(adjustment.amount),
    note: adjustment.note ?? '',
    accountId: adjustment.accountId ?? '',
    auto: adjustment.auto === true,
  }));
}

/** The number a user typed: `null` for nothing, or something that is not a number. */
export function parseAmount(text: string): number | null {
  const cleaned = text.replaceAll(/[\s,$]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Dollars rounded to whole cents. */
export function roundMoney(value: number): number {
  return toCents(value) / 100;
}

/** Ids of the draft rows whose amount is missing or not a number. */
export function invalidDraftIds(drafts: readonly AdjustmentDraft[]): string[] {
  return drafts.filter((draft) => parseAmount(draft.amount) === null).map((draft) => draft.id);
}

/** The `adjustments` payload of a PATCH: signed amounts in dollars; empty notes and accounts are left out. */
export function draftsToAdjustments(drafts: readonly AdjustmentDraft[]): ReturnAdjustment[] {
  return drafts.map((draft) => {
    const note = draft.note.trim();
    const adjustment: ReturnAdjustment = { type: draft.type, amount: roundMoney(parseAmount(draft.amount) ?? 0) };
    if (note) adjustment.note = note.slice(0, 255);
    if (draft.type === 'other' && draft.accountId) adjustment.accountId = draft.accountId;
    if (draft.auto) adjustment.auto = true;
    return adjustment;
  });
}

function normalize(adjustment: ReturnAdjustment): string {
  return JSON.stringify([
    adjustment.type,
    toCents(adjustment.amount),
    adjustment.note ?? '',
    adjustment.type === 'other' ? (adjustment.accountId ?? '') : '',
    adjustment.auto === true,
  ]);
}

/** Do the draft rows say what the return already stores? Nothing to save, then. */
export function draftsMatch(drafts: readonly AdjustmentDraft[], stored: readonly ReturnAdjustment[] | null | undefined): boolean {
  if (invalidDraftIds(drafts).length > 0) return false;
  const current = draftsToAdjustments(drafts).map(normalize);
  const saved = (stored ?? []).map(normalize);
  return current.length === saved.length && current.every((value, index) => value === saved[index]);
}

/** Which sign an adjustment type usually has: a discount reduces the payment, a penalty adds to it. */
export function usualSign(type: AdjustmentType): 'negative' | 'positive' | null {
  if (type === 'vendor_discount' || type === 'prepayment') return 'negative';
  if (type === 'penalty' || type === 'interest') return 'positive';
  return null;
}

/** True when an entered amount has the opposite sign of what the type usually has (a hint, not an error). */
export function unusualSign(type: AdjustmentType, amount: number | null): boolean {
  if (amount === null || amount === 0) return false;
  const usual = usualSign(type);
  if (usual === 'negative') return amount > 0;
  if (usual === 'positive') return amount < 0;
  return false;
}

export interface ReturnTotals {
  salesTaxPayable: number;
  useTaxPayable: number;
  adjustmentsTotal: number;
  totalDue: number;
}

/** What the return pays: the tax payable plus the signed adjustments, summed in cents like the server does. */
export function returnTotals(
  summary: Pick<ReturnSummary, 'salesTaxPayable' | 'useTaxPayable'> | null | undefined,
  adjustments: ReadonlyArray<Pick<ReturnAdjustment, 'amount'>>,
): ReturnTotals {
  const sales = toCents(summary?.salesTaxPayable ?? 0);
  const use = toCents(summary?.useTaxPayable ?? 0);
  const adjusted = adjustments.reduce((sum, adjustment) => sum + toCents(adjustment.amount), 0);
  return {
    salesTaxPayable: sales / 100,
    useTaxPayable: use / 100,
    adjustmentsTotal: adjusted / 100,
    totalDue: (sales + use + adjusted) / 100,
  };
}

/** Total due of the rows being edited: a row without a valid amount counts as nothing. */
export function draftsTotals(
  summary: Pick<ReturnSummary, 'salesTaxPayable' | 'useTaxPayable'> | null | undefined,
  drafts: readonly AdjustmentDraft[],
): ReturnTotals {
  return returnTotals(
    summary,
    drafts.map((draft) => ({ amount: parseAmount(draft.amount) ?? 0 })),
  );
}

// ============================================================================
// Payment
// ============================================================================

/** The amount paid minus the total due, in dollars rounded to cents. */
export function paymentDifference(totalDue: number, amount: number): number {
  return (toCents(amount) - toCents(totalDue)) / 100;
}

/** A payment that differs from the total due needs a reason (the difference goes to rounding). */
export function paymentNeedsReason(totalDue: number, amount: number): boolean {
  return !sameAmount(totalDue, amount);
}

/** Why a payment amount cannot be recorded for a return, or null when it can. */
export function paymentAmountProblem(totalDue: number, amount: number): 'negative' | 'positive' | null {
  if (totalDue > 0 && amount < 0) return 'negative';
  if (totalDue < 0 && amount > 0) return 'positive';
  return null;
}

// ============================================================================
// Errors and checks
// ============================================================================

/** The ledger moved since the calculation: the server asks for a recalculation (409). */
export function isRecalculateConflict(err: unknown): boolean {
  return isSalesTaxRequestError(err) && err.status === 409 && /recalculate/i.test(err.message);
}

export type SkippedReason = 'cash_basis' | 'already_filed' | 'no_payable_account';

export interface SkippedCheck {
  /** The check that did not run (`net_sales_difference`, `payable_direct_entries`). */
  code: string;
  reason: SkippedReason | null;
  /** The server's own wording, shown when the reason is not one we know. */
  raw: string;
}

/** Reads a `<code>: <reason>` line of the pre-file check's `skipped` list. */
export function parseSkipped(entry: string): SkippedCheck {
  const separator = entry.indexOf(':');
  const code = (separator >= 0 ? entry.slice(0, separator) : entry).trim();
  const text = separator >= 0 ? entry.slice(separator + 1).trim() : '';
  let reason: SkippedReason | null = null;
  if (/cash-basis/i.test(text)) reason = 'cash_basis';
  else if (/already filed/i.test(text)) reason = 'already_filed';
  else if (/no payable account/i.test(text)) reason = 'no_payable_account';
  return { code, reason, raw: text || entry };
}
