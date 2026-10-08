import type { BankFeedSyncOutcome } from '@/lib/api/domains/weldbooks-bank-feeds';
import type { FeedTexts, FormatText, PluralText } from './feed-texts';

export interface SyncMessage {
  kind: 'success' | 'info' | 'error';
  text: string;
}

/**
 * What a manual sync says. books-api answers 200 even when the provider
 * failed, so the outcome carries the verdict: a skip (nothing ran), an error
 * (it ran and failed), or counts.
 */
export function describeSyncOutcome(
  outcome: BankFeedSyncOutcome,
  t: FeedTexts,
  format: FormatText,
  plural: PluralText,
): SyncMessage {
  switch (outcome.skipped) {
    case 'in_progress':
      return { kind: 'info', text: t.sync.inProgress };
    case 'not_active':
      return { kind: 'error', text: t.sync.notActive };
    case 'no_mapped_accounts':
      return { kind: 'error', text: t.sync.noAccounts };
    case 'not_found':
      return { kind: 'error', text: t.sync.notFound };
    default:
      break;
  }

  if (outcome.error) {
    return { kind: 'error', text: format(t.sync.failed, { error: outcome.error }) };
  }

  const changed = outcome.added + outcome.updated + outcome.removed;
  if (changed === 0 && outcome.autoReconciled === 0) return { kind: 'success', text: t.sync.upToDate };

  const done = format(t.sync.done, { added: outcome.added, updated: outcome.updated, removed: outcome.removed });
  const matched = outcome.autoReconciled > 0 ? ` ${plural(outcome.autoReconciled, { other: t.sync.matched })}` : '';
  return { kind: 'success', text: `${done}${matched}` };
}
