/**
 * The best suggestion for the selected line as one primary button (Enter
 * accepts it), with the matcher's reasons as small chips; or a calm "No sure
 * match" note when nothing fits well enough.
 */

import { Check, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Kbd } from '@weldsuite/ui/components/kbd';
import type { MatchSuggestion, SuggestionType } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { reasonLabel } from '../components/suggestion-list';

type Copy = ReturnType<typeof useI18n>['t']['weldbooksConnected']['processing']['suggestion'];

const BUTTON_KEYS: Record<SuggestionType, 'linkInvoice' | 'linkBill' | 'linkPayment' | 'linkDeposit' | 'bookRule'> = {
  invoice: 'linkInvoice',
  bill: 'linkBill',
  payment: 'linkPayment',
  deposit: 'linkDeposit',
  rule: 'bookRule',
};

const TITLE_KEYS: Record<SuggestionType, 'invoiceTitle' | 'billTitle' | 'paymentTitle' | 'depositTitle' | 'ruleTitle'> = {
  invoice: 'invoiceTitle',
  bill: 'billTitle',
  payment: 'paymentTitle',
  deposit: 'depositTitle',
  rule: 'ruleTitle',
};

/** What the suggestion is, for the success line: "invoice 2026-0142". */
export function suggestionTarget(suggestion: MatchSuggestion, copy: Copy): string {
  return copy[TITLE_KEYS[suggestion.type]].replace('{number}', suggestion.number ?? copy.noNumber);
}

/** The primary button's text: "Link to invoice 2026-0142". */
export function suggestionActionLabel(suggestion: MatchSuggestion, copy: Copy): string {
  return copy[BUTTON_KEYS[suggestion.type]].replace('{number}', suggestion.number ?? copy.noNumber);
}

export interface SuggestionCardProps {
  suggestion: MatchSuggestion | null;
  loading: boolean;
  formatAmount: (amount: string | number) => string;
  pending: boolean;
  readOnly: boolean;
  errorMessage: string | null;
  onAccept: () => void;
  /** Opens the document search ("Not this one? Search"). */
  onSearch: () => void;
}

export function SuggestionCard({
  suggestion,
  loading,
  formatAmount,
  pending,
  readOnly,
  errorMessage,
  onAccept,
  onSearch,
}: Readonly<SuggestionCardProps>) {
  const { t } = useI18n();
  const copy = t.weldbooksConnected.processing.suggestion;
  const reasons = t.weldbooksUs.banking.suggestions.reasons;

  if (!suggestion) {
    return (
      <section
        className="space-y-1.5 rounded-xl border border-dashed p-5"
        aria-label={copy.none.title}
        data-testid="no-sure-match"
      >
        <p className="font-semibold">{loading ? copy.loading : copy.none.title}</p>
        {loading ? null : <p className="text-sm text-muted-foreground">{copy.none.description}</p>}
      </section>
    );
  }

  const label = suggestion.type === 'rule' ? copy.ruleLabel : copy.label;
  const contact = suggestion.contactName ? ` · ${suggestion.contactName}` : '';
  return (
    <section
      className="space-y-3 rounded-xl border border-primary/60 bg-primary/5 p-5"
      aria-label={label}
      data-testid="suggestion-card"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">{label}</p>
      <div className="space-y-0.5">
        <p className="text-base font-semibold">
          {suggestionTarget(suggestion, copy)}
          {contact}
        </p>
        <p className="text-sm text-muted-foreground tabular-nums">{formatAmount(suggestion.amount)}</p>
      </div>
      {suggestion.reasons.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={copy.label}>
          {suggestion.reasons.map((reason) => (
            <li
              key={reason}
              className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-0.5 text-xs"
            >
              <Check className="h-3 w-3 text-emerald-600" aria-hidden />
              {reasonLabel(reason, reasons)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="lg"
          onClick={onAccept}
          disabled={pending || readOnly}
          aria-keyshortcuts="Enter"
          data-testid="accept-suggestion"
        >
          {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
          {suggestionActionLabel(suggestion, copy)}
          <Kbd className="ml-1 bg-primary-foreground/15 text-primary-foreground">⏎</Kbd>
        </Button>
        <Button type="button" variant="link" size="sm" onClick={onSearch}>
          {copy.notThisOne}
        </Button>
      </div>
      {errorMessage ? (
        <p className="text-sm text-destructive" role="alert" data-testid="suggestion-error">
          {errorMessage}
        </p>
      ) : null}
    </section>
  );
}
