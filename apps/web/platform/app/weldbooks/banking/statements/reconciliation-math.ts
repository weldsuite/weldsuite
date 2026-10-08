/**
 * Statement reconciliation arithmetic for the worksheet. Mirrors
 * `computeBalances` in books-api (`accounting-bank-reconciliation-statement.ts`),
 * so the difference shown while ticking is the one the server checks on
 * Finish. Everything is added in whole cents.
 */
import type { ReconciliationHistoryRow, ReconciliationLine } from '@/lib/api/domains/weldbooks-banking';

const cents = (amount: number) => Math.round(amount * 100);

export interface LineTotals {
  count: number;
  total: number;
}

export interface StatementBalances {
  beginningBalance: number;
  statementEndingBalance: number;
  clearedInflows: LineTotals;
  clearedOutflows: LineTotals;
  clearedBalance: number;
  /** Statement ending balance minus the cleared balance; zero when the books agree with the statement. */
  difference: number;
}

function totalOf(lines: readonly ReconciliationLine[], ids: ReadonlySet<string>): LineTotals {
  const ticked = lines.filter((l) => ids.has(l.id));
  return { count: ticked.length, total: ticked.reduce((sum, l) => sum + cents(l.amount), 0) / 100 };
}

/**
 * Cleared balance and difference for the ticked lines. A bank account's
 * balance is what it holds and deposits add to it. A credit card's is what is
 * owed: charges add to it and payments reduce it, so the signs flip.
 */
export function computeStatementBalances(args: {
  beginningBalance: number;
  statementEndingBalance: number;
  accountKind: 'bank' | 'credit_card';
  inflows: readonly ReconciliationLine[];
  outflows: readonly ReconciliationLine[];
  clearedIds: ReadonlySet<string>;
}): StatementBalances {
  const clearedInflows = totalOf(args.inflows, args.clearedIds);
  const clearedOutflows = totalOf(args.outflows, args.clearedIds);
  const sign = args.accountKind === 'credit_card' ? -1 : 1;
  const clearedCents =
    cents(args.beginningBalance) + sign * (cents(clearedInflows.total) - cents(clearedOutflows.total));
  return {
    beginningBalance: args.beginningBalance,
    statementEndingBalance: args.statementEndingBalance,
    clearedInflows,
    clearedOutflows,
    clearedBalance: clearedCents / 100,
    difference: (cents(args.statementEndingBalance) - clearedCents) / 100,
  };
}

/** Finish is allowed only when the cleared balance equals the statement's. */
export function differenceIsZero(balances: Pick<StatementBalances, 'difference'>): boolean {
  return cents(balances.difference) === 0;
}

export type ClearedFilter = 'all' | 'cleared' | 'uncleared';

/** The lines matching a search text and the cleared filter. */
export function filterLines(
  lines: readonly ReconciliationLine[],
  options: { query: string; show: ClearedFilter; clearedIds: ReadonlySet<string> },
): ReconciliationLine[] {
  const query = options.query.trim().toLowerCase();
  return lines.filter((line) => {
    const isCleared = options.clearedIds.has(line.id);
    if (options.show === 'cleared' && !isCleared) return false;
    if (options.show === 'uncleared' && isCleared) return false;
    if (!query) return true;
    const haystack = [
      line.description,
      line.contactName,
      line.entryNumber,
      line.reference,
      line.document?.number,
      line.document?.checkNumber,
      line.amount.toFixed(2),
    ];
    return haystack.some((value) => value?.toLowerCase().includes(query));
  });
}

/** The ticked ids after ticking or clearing every one of `lines`. */
export function setAllTicked(
  clearedIds: ReadonlySet<string>,
  lines: readonly Pick<ReconciliationLine, 'id'>[],
  ticked: boolean,
): Set<string> {
  const next = new Set(clearedIds);
  for (const line of lines) {
    if (ticked) next.add(line.id);
    else next.delete(line.id);
  }
  return next;
}

/** True when `ids` holds every one of `lines` (and there is at least one). */
export function allTicked(ids: ReadonlySet<string>, lines: readonly Pick<ReconciliationLine, 'id'>[]): boolean {
  return lines.length > 0 && lines.every((l) => ids.has(l.id));
}

/** True when both sets hold the same ids. */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// ── History ─────────────────────────────────────────────────────────────────

type HistoryRow = Pick<ReconciliationHistoryRow, 'id' | 'status' | 'statementDate' | 'createdAt' | 'bankAccountId'>;

/** The most recent completed reconciliation of an account: the only one that can be undone. */
export function latestCompleted<T extends HistoryRow>(rows: readonly T[], bankAccountId: string): T | undefined {
  return rows
    .filter((r) => r.bankAccountId === bankAccountId && r.status === 'completed')
    .sort((a, b) => b.statementDate.localeCompare(a.statementDate) || b.createdAt.localeCompare(a.createdAt))[0];
}

/** The reconciliation of an account that is still open, if any. */
export function inProgressOf<T extends HistoryRow>(rows: readonly T[], bankAccountId: string): T | undefined {
  return rows.find((r) => r.bankAccountId === bankAccountId && r.status === 'in_progress');
}

/** A typed statement balance (`1,234.56`, `-20`); null when it isn't a number. Credit card balances owed are positive. */
export function parseStatementBalance(text: string): number | null {
  const value = text.trim().replaceAll(/[$,\s]/g, '');
  if (!/^-?(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(value)) return null;
  return Number.parseFloat(value);
}

export type AdjustmentDirection = 'bankHoldsMore' | 'bankHoldsLess' | 'cardOwesMore' | 'cardOwesLess';

/**
 * Which way an adjustment goes: the statement says the bank holds more (or the
 * card is owed more) than the ticked lines add up to, or less.
 */
export function adjustmentDirection(accountKind: 'bank' | 'credit_card', difference: number): AdjustmentDirection {
  const higher = difference > 0;
  if (accountKind === 'credit_card') return higher ? 'cardOwesMore' : 'cardOwesLess';
  return higher ? 'bankHoldsMore' : 'bankHoldsLess';
}

/** The ticked ids that are dated on or before `date` (`YYYY-MM-DD`), so moving the statement date back never leaves a later line ticked. */
export function tickedOnOrBefore(
  lines: readonly Pick<ReconciliationLine, 'id' | 'date'>[],
  ticked: ReadonlySet<string>,
  date: string,
): string[] {
  return lines.filter((l) => ticked.has(l.id) && l.date.slice(0, 10) <= date).map((l) => l.id);
}
