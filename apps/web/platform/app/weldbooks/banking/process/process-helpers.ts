/** Types and pure helpers of the processing view (see `process-view.tsx`). */

import type { Account } from '@/lib/api/domains/weldbooks';
import type { BankLine, MatchDocumentsResult, MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';
import type { CategorizeInput, TransferResult } from '@/lib/api/domains/weldbooks-processing';
import type { useI18n } from '@/lib/i18n/provider';
import { suggestionTarget } from './suggestion-card';

export type Mode = 'category' | 'receipt' | 'transfer' | 'several';
export type DoneKind = 'suggestion' | 'category' | 'transfer' | 'private' | 'ignore' | 'documents';

/** A line processed in this visit: kept in the queue marked Done, with the line of text its success banner shows. */
export interface DoneEntry {
  line: BankLine;
  text: string;
  kind: DoneKind;
  /** Where the line sat in the queue, so it stays there. */
  index: number;
}

export interface ProcessSearch {
  accountId?: string;
  lineId?: string;
  action?: string;
  view?: string;
}

export type ProcessingCopy = ReturnType<typeof useI18n>['t']['weldbooksConnected']['processing'];

export const MODES: readonly Mode[] = ['category', 'receipt', 'transfer', 'several'];

/** The mode a `?action=` search value opens, if it names one. */
export function initialMode(action: string | undefined): Mode | null {
  return MODES.find((mode) => mode === action) ?? null;
}

/** A copy of the record without one key. */
export function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '';
}

export function ledgerAccountName(accounts: Account[], id: string | null | undefined): string {
  return accounts.find((candidate) => candidate.id === id)?.name ?? '';
}

/** The Done entry of the selected line, and the one whose banner shows (the selected one, else the last processed). */
export function doneEntriesOf(
  done: Record<string, DoneEntry>,
  selectedId: string | null,
  lastDoneId: string | null,
): { selectedDone: DoneEntry | null; bannerEntry: DoneEntry | null } {
  const selectedDone = selectedId ? (done[selectedId] ?? null) : null;
  const last = lastDoneId ? (done[lastDoneId] ?? null) : null;
  return { selectedDone, bannerEntry: selectedDone ?? last };
}

export function suggestionText(best: MatchSuggestion, tp: ProcessingCopy): string {
  if (best.type === 'rule') return tp.result.suggestionRule;
  return tp.result.suggestion.replace('{target}', suggestionTarget(best, tp.suggestion));
}

export function categoryText(input: CategorizeInput, tr: ProcessingCopy['result'], accounts: Account[]): string {
  if (input.lines.length > 1) return tr.categoryMany.replace('{count}', String(input.lines.length));
  return tr.category.replace('{category}', ledgerAccountName(accounts, input.lines[0]?.accountId));
}

export function transferText(
  result: TransferResult,
  bankAccounts: readonly { id: string; name: string }[],
  tr: ProcessingCopy['result'],
): string {
  const counterpartId = result.counterpart?.bankAccountId;
  const other = counterpartId ? bankAccounts.find((account) => account.id === counterpartId) : undefined;
  return other ? tr.transferPaired.replace('{account}', other.name) : tr.transfer;
}

export function documentsText(
  result: MatchDocumentsResult,
  tr: ProcessingCopy['result'],
  formatAmount: (amount: string) => string,
): string {
  const rounding = result.roundingDifference;
  return rounding ? tr.documentsRounding.replace('{amount}', formatAmount(rounding.amount)) : tr.documents;
}
