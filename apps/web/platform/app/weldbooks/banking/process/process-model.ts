/**
 * Pure helpers of the processing view: which suggestion is the one to offer,
 * how the queue keeps finished lines in place, which line opens next and
 * whether the counterparty is one of the entity's own accounts.
 */

import type { BankLine, BankLineAutoReason, BankLineLinks, MatchSuggestion } from '@/lib/api/domains/weldbooks-banking';

/** A suggestion below this confidence is not "sure": the view says so instead of offering a button. */
export const SURE_CONFIDENCE = 0.6;

/** The one suggestion to offer as the primary button, or null when none is sure enough. */
export function bestSuggestion(suggestions: readonly MatchSuggestion[]): MatchSuggestion | null {
  let best: MatchSuggestion | null = null;
  for (const suggestion of suggestions) {
    if (suggestion.confidence < SURE_CONFIDENCE) continue;
    if (!best || suggestion.confidence > best.confidence) best = suggestion;
  }
  return best;
}

export type LineDirection = 'in' | 'out';

export function directionOf(line: Pick<BankLine, 'amount'>): LineDirection {
  return Number(line.amount) < 0 ? 'out' : 'in';
}

/** A line that was processed in this visit and is kept in the queue, marked Done, where it was. */
export interface RetainedLine {
  line: BankLine;
  /** Its position in the queue when it was processed. */
  index: number;
}

/**
 * The queue as shown: the server's lines, with every retained line that has
 * left the server's list put back at the position it had, so the list does
 * not jump after an action.
 */
export function mergeQueue(serverLines: readonly BankLine[], retained: readonly RetainedLine[]): BankLine[] {
  const present = new Set(serverLines.map((line) => line.id));
  const merged = [...serverLines];
  const missing = retained.filter((entry) => !present.has(entry.line.id)).sort((a, b) => a.index - b.index);
  for (const entry of missing) merged.splice(Math.min(entry.index, merged.length), 0, entry.line);
  return merged;
}

/**
 * The line to open after `currentId`: the next one that is not done, then
 * wrapping to the first. Null when every line is done.
 */
export function nextLineId(
  queue: readonly Pick<BankLine, 'id'>[],
  done: ReadonlySet<string>,
  currentId: string | null,
): string | null {
  if (queue.length === 0) return null;
  const at = currentId ? queue.findIndex((line) => line.id === currentId) : -1;
  for (let step = 1; step <= queue.length; step += 1) {
    const candidate = queue[(at + step + queue.length) % queue.length];
    if (candidate && !done.has(candidate.id)) return candidate.id;
  }
  return null;
}

/** The line `delta` places from the current one (J = +1, K = -1), staying within the queue. */
export function stepLineId(
  queue: readonly Pick<BankLine, 'id'>[],
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  if (queue.length === 0) return null;
  const at = currentId ? queue.findIndex((line) => line.id === currentId) : -1;
  if (at === -1) return queue[delta === 1 ? 0 : queue.length - 1]!.id;
  const target = Math.min(queue.length - 1, Math.max(0, at + delta));
  return queue[target]!.id;
}

const normalizeIban = (iban: string | null | undefined): string => (iban ?? '').replace(/\s+/g, '').toUpperCase();

/** One of the entity's other bank accounts that the line's counterparty IBAN belongs to. */
export function ownAccountForLine<T extends { id: string; iban: string | null }>(
  line: Pick<BankLine, 'bankAccountId' | 'counterpartyIban'>,
  accounts: readonly T[],
): T | null {
  const iban = normalizeIban(line.counterpartyIban);
  if (!iban) return null;
  return accounts.find((account) => account.id !== line.bankAccountId && normalizeIban(account.iban) === iban) ?? null;
}

/** The words of every automatic reason, with `{name}` in the rule's. */
export interface AutomaticReasonCopy {
  document_match: string;
  own_account_transfer: string;
  tax_authority: string;
  rule: string;
  other: string;
}

/** The reason a line was booked automatically, in words. A reason this build does not know reads as the generic one. */
export function automaticReasonLabel(
  reason: BankLineAutoReason | null | undefined,
  rule: BankLineLinks['rule'],
  copy: AutomaticReasonCopy,
): string {
  switch (reason) {
    case 'rule':
      return copy.rule.replace('{name}', rule?.name ?? '');
    case 'document_match':
      return copy.document_match;
    case 'own_account_transfer':
      return copy.own_account_transfer;
    case 'tax_authority':
      return copy.tax_authority;
    default:
      return copy.other;
  }
}
