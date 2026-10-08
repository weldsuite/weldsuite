import { Link2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import type { MatchSuggestion, SuggestionType } from '@/lib/api/domains/weldbooks-banking';

type ReasonKey =
  | 'exactAmount'
  | 'closeAmount'
  | 'invoiceNumberInReference'
  | 'invoiceNumberInEndToEnd'
  | 'ibanMatchesContact'
  | 'ibanMatchesVendor'
  | 'nameMatchesCustomer'
  | 'namePartlyMatchesCustomer'
  | 'nameMatchesVendor'
  | 'namePartlyMatchesVendor'
  | 'nameMatchesPaymentContact'
  | 'namePartlyMatchesPaymentContact'
  | 'datedBeforeDocument'
  | 'insidePaymentWindow'
  | 'externalReferenceInDescription'
  | 'checkNumberMatches'
  | 'checkNumberMatchesAmountDiffers'
  | 'datesWithin30Days'
  | 'depositTotalMatches'
  | 'depositDatedWithinWeek';

/** The reason strings books-api's matcher writes, mapped to translation keys. */
const REASON_KEYS: Readonly<Record<string, ReasonKey>> = {
  'exact amount match': 'exactAmount',
  'close amount match': 'closeAmount',
  'invoice number in reference': 'invoiceNumberInReference',
  'invoice number in end-to-end ID': 'invoiceNumberInEndToEnd',
  'counterparty IBAN matches contact': 'ibanMatchesContact',
  'counterparty IBAN matches vendor': 'ibanMatchesVendor',
  'name matches the customer': 'nameMatchesCustomer',
  'name partly matches the customer': 'namePartlyMatchesCustomer',
  'name matches the vendor': 'nameMatchesVendor',
  'name partly matches the vendor': 'namePartlyMatchesVendor',
  "name matches the payment's contact": 'nameMatchesPaymentContact',
  "name partly matches the payment's contact": 'namePartlyMatchesPaymentContact',
  'dated before the document': 'datedBeforeDocument',
  'inside the payment window': 'insidePaymentWindow',
  'external reference in description': 'externalReferenceInDescription',
  'check number matches': 'checkNumberMatches',
  'check number matches but the amount differs': 'checkNumberMatchesAmountDiffers',
  'dates within 30 days': 'datesWithin30Days',
  'deposit total matches': 'depositTotalMatches',
  'deposit dated within a week': 'depositDatedWithinWeek',
};

/** A match reason in the user's language; one this app doesn't know is shown as the server wrote it. */
export function reasonLabel(reason: string, labels: Readonly<Record<ReasonKey, string>>): string {
  const key = REASON_KEYS[reason];
  return key ? labels[key] : reason;
}

/** Confidence as a whole percentage, kept within 0 to 100. */
export function confidencePercent(confidence: number): number {
  return Math.min(100, Math.max(0, Math.round(confidence * 100)));
}

/** Bar colour for a confidence percentage. */
function confidenceTone(percent: number): string {
  if (percent >= 75) return 'bg-emerald-500';
  return percent >= 40 ? 'bg-amber-500' : 'bg-muted-foreground';
}

const TYPE_VARIANT: Record<SuggestionType, 'default' | 'secondary' | 'outline' | 'success'> = {
  invoice: 'default',
  bill: 'secondary',
  payment: 'success',
  deposit: 'outline',
};

interface SuggestionListProps {
  suggestions: readonly MatchSuggestion[];
  formatAmount: (amount: string | number) => string;
  pending?: boolean;
  /** Everything the user can't do (no `banking:update`). */
  readOnly?: boolean;
  onMatch: (suggestion: MatchSuggestion) => void;
}

/**
 * What the books know about a bank line: open invoices and bills, payments
 * that were recorded before the line arrived (a check that cleared) and
 * deposits. Invoices and bills post a new payment; a payment or deposit is
 * only linked, since its entry already exists.
 */
export function SuggestionList({ suggestions, formatAmount, pending, readOnly, onMatch }: Readonly<SuggestionListProps>) {
  const { t } = useI18n();
  const ts = t.weldbooksUs.banking.suggestions;

  return (
    <ul className="space-y-3" data-testid="match-suggestions">
      {suggestions.map((s) => {
        const percent = confidencePercent(s.confidence);
        return (
          <li key={`${s.type}-${s.id}`} className="space-y-2 rounded-lg border p-3" data-testid={`suggestion-${s.type}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-sm font-medium">{s.number || s.id}</span>
                {s.contactName ? <span className="ml-2 text-xs text-muted-foreground">({s.contactName})</span> : null}
              </div>
              <Badge variant={TYPE_VARIANT[s.type]}>{ts.types[s.type]}</Badge>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="tabular-nums">{formatAmount(s.amount)}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                <span
                  className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={ts.confidenceLabel}
                >
                  <span
                    className={cn('block h-full rounded-full', confidenceTone(percent))}
                    style={{ width: `${percent}%` }}
                  />
                </span>
                {ts.confidence.replace('{percent}', String(percent))}
              </span>
            </div>
            {s.reasons.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {s.reasons.map((reason) => (
                  <li key={reason} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {reasonLabel(reason, ts.reasons)}
                  </li>
                ))}
              </ul>
            ) : null}
            {s.type === 'payment' || s.type === 'deposit' ? (
              <p className="text-xs text-muted-foreground">{ts.linkOnlyHint}</p>
            ) : null}
            <Button size="sm" onClick={() => onMatch(s)} disabled={pending || readOnly} data-testid={`match-${s.type}`}>
              <Link2 className="mr-1 h-4 w-4" />
              {ts.actions[s.type]}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
