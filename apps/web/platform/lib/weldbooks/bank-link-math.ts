/**
 * The sums behind matching a bank transaction to documents (edition feature
 * `books-bank-links`): which amounts go to which invoice or bill, and what
 * happens to a gap between the transaction and the documents. Pure, in whole
 * cents, so the screen and the request agree to the cent.
 */
import type { MatchDocumentsInput } from '@/lib/api/domains/weldbooks-banking';

/** What to do with a gap between the transaction and the documents. */
export type GapChoice =
  /** Documents take more: the last ones stay partly open. Money is more: the rest stays as credit for the contact. */
  | 'leave'
  /** Book the gap to a ledger account (bank costs, a payment discount, rounding). */
  | 'account';

export interface ShareInput {
  id: string;
  /** Credit notes are sent as invoices. */
  type: 'invoice' | 'bill';
  /** As typed. */
  amount: string;
  /** What the document still takes. */
  openAmount: string | number;
}

export type PlanProblem = 'noDocuments' | 'invalidAmount' | 'overOpen' | 'needsAccount';

export interface MatchPlan {
  /** The transaction, in cents (positive). */
  paidCents: number;
  /** The amounts as typed, in cents. */
  allocatedCents: number;
  /** Typed amounts less the transaction: positive when the documents take more. */
  gapCents: number;
  /** The request body, when the plan holds. */
  body: MatchDocumentsInput | null;
  problem: PlanProblem | null;
  /** The document a problem is about. */
  problemId?: string;
  /** With `leave` and documents taking more: what each document gets, by id. */
  fitted: Record<string, number>;
}

/** Amount text (a comma or a dot for the decimals) in whole cents; NaN for anything else. */
export function toCents(value: string | number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN;
  const text = value.trim().replace(/\s/g, '');
  if (!/^-?\d+([.,]\d{1,2})?$/.test(text)) return Number.NaN;
  return Math.round(Number(text.replace(',', '.')) * 100);
}

/** Cents as the API's amount text: `12.34`. */
export function fromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** What each document gets when they share `paidCents` in order: the first ones in full, the last partly. */
export function fitToTransaction(paidCents: number, amounts: readonly number[]): number[] {
  let left = paidCents;
  return amounts.map((amount) => {
    const take = Math.max(0, Math.min(amount, left));
    left -= take;
    return take;
  });
}

/** The default amount for a document picked after `others`: its open amount, or what is left of the transaction. */
export function defaultShare(paidCents: number, othersCents: number, openCents: number): number {
  const left = paidCents - othersCents;
  return left > 0 ? Math.min(openCents, left) : openCents;
}

export function planMatch(input: {
  /** The transaction's amount (signed is fine). */
  transactionAmount: string | number;
  shares: readonly ShareInput[];
  choice: GapChoice;
  accountId?: string | null;
  description?: string;
}): MatchPlan {
  const paidCents = Math.abs(toCents(input.transactionAmount));
  const empty = { paidCents, allocatedCents: 0, gapCents: -paidCents, body: null, fitted: {} };
  if (input.shares.length === 0) return { ...empty, problem: 'noDocuments' };
  const amounts: number[] = [];
  for (const share of input.shares) {
    const cents = toCents(share.amount);
    if (!Number.isFinite(cents) || cents <= 0) return { ...empty, problem: 'invalidAmount', problemId: share.id };
    if (cents > toCents(share.openAmount)) return { ...empty, problem: 'overOpen', problemId: share.id };
    amounts.push(cents);
  }
  const allocatedCents = amounts.reduce((sum, cents) => sum + cents, 0);
  const gapCents = allocatedCents - paidCents;
  const plan = { paidCents, allocatedCents, gapCents, fitted: {} as Record<string, number> };
  if (gapCents !== 0 && input.choice === 'account' && !input.accountId) {
    return { ...plan, body: null, problem: 'needsAccount' };
  }
  let sent = amounts;
  if (gapCents > 0 && input.choice === 'leave') {
    sent = fitToTransaction(paidCents, amounts);
    input.shares.forEach((share, i) => {
      plan.fitted[share.id] = sent[i];
    });
  }
  const documents = input.shares
    .map((share, i) => ({ type: share.type, id: share.id, amount: fromCents(sent[i]) }))
    .filter((_, i) => sent[i] > 0);
  const body: MatchDocumentsInput = { documents };
  if (gapCents !== 0 && input.choice === 'account' && input.accountId) {
    body.differenceAccountId = input.accountId;
    if (input.description) body.differenceDescription = input.description;
  }
  return { ...plan, body, problem: null };
}
