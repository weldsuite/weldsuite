/**
 * "Paid with": the bank lines that could have paid the document (the sure one
 * preselected), then not paid yet, cash and paid privately, as one radio list.
 * A credit note is only ever "not paid yet", so it shows that alone.
 */

import { useId, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { cn } from '@/lib/utils';
import type { BankCandidate } from '@/lib/api/domains/weldbooks-receipts';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { canPayWith, reasonKeys, type PaidChoice, type ReviewState } from './review-model';

const BANK_PREFIX = 'bank:';

/** The radio value of a choice, and back. */
export function paidValue(choice: PaidChoice): string {
  return choice.type === 'bank_transaction' ? `${BANK_PREFIX}${choice.bankTransactionId}` : choice.type;
}

export function paidChoiceOf(value: string): PaidChoice {
  if (value.startsWith(BANK_PREFIX)) return { type: 'bank_transaction', bankTransactionId: value.slice(BANK_PREFIX.length) };
  if (value === 'cash') return { type: 'cash' };
  if (value === 'private') return { type: 'private' };
  return { type: 'none' };
}

function Option({
  id,
  value,
  selected,
  children,
}: Readonly<{ id: string; value: string; selected: boolean; children: ReactNode }>) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/40',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        selected && 'border-primary bg-primary/5',
      )}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
    </label>
  );
}

export interface PaidWithListProps {
  kind: ReviewState['kind'];
  candidates: readonly BankCandidate[];
  loading: boolean;
  value: PaidChoice;
  onChange: (choice: PaidChoice) => void;
  currency?: string | null;
  /** Paying with a bank line needs `banking:update`. */
  allowBankLine?: boolean;
  /** Cash and private payments need `banking:create`. */
  allowCashPrivate?: boolean;
}

export function PaidWithList({
  kind,
  candidates,
  loading,
  value,
  onChange,
  currency,
  allowBankLine = true,
  allowCashPrivate = true,
}: Readonly<PaidWithListProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksReceipts.review.paidWith;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const ids = useId();
  const current = paidValue(value);
  const payable = canPayWith(kind);
  const withBank = payable && allowBankLine;
  const withCash = payable && allowCashPrivate;

  return (
    <fieldset className="space-y-2" data-testid="paid-with">
      <legend className="mb-1 text-sm font-medium">{tp.legend}</legend>
      <RadioGroup
        value={payable ? current : 'none'}
        onValueChange={(next) => onChange(paidChoiceOf(next))}
        aria-label={tp.legend}
        className="gap-2"
      >
        {withBank
          ? candidates.map((candidate) => {
              const radioId = `${ids}-${candidate.id}`;
              const reasons = reasonKeys(candidate.reasons);
              const name = candidate.counterpartyName?.trim();
              return (
                <Option key={candidate.id} id={radioId} value={`${BANK_PREFIX}${candidate.id}`} selected={current === `${BANK_PREFIX}${candidate.id}`}>
                  <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 truncate font-medium">
                      {name
                        ? tp.bankLine.replace('{date}', formatDate(candidate.date)).replace('{name}', name)
                        : tp.bankLineNoName.replace('{date}', formatDate(candidate.date))}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{formatMoney(Math.abs(Number(candidate.amount)), currency)}</span>
                      <SoftBadge tone={candidate.sure ? 'success' : 'neutral'}>{candidate.sure ? tp.sure : tp.possible}</SoftBadge>
                    </span>
                  </span>
                  {reasons.length > 0 ? (
                    <span className="text-xs text-muted-foreground">{reasons.map((reason) => tp.reasons[reason]).join(' · ')}</span>
                  ) : null}
                </Option>
              );
            })
          : null}

        {withBank && loading ? (
          <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {tp.loading}
          </p>
        ) : null}

        <Option id={`${ids}-none`} value="none" selected={!payable || current === 'none'}>
          <span className="font-medium">{tp.none}</span>
          <span className="text-xs text-muted-foreground">{tp.noneHint}</span>
        </Option>
        {withCash ? (
          <>
            <Option id={`${ids}-cash`} value="cash" selected={current === 'cash'}>
              <span className="font-medium">{tp.cash}</span>
              <span className="text-xs text-muted-foreground">{tp.cashHint}</span>
            </Option>
            <Option id={`${ids}-private`} value="private" selected={current === 'private'}>
              <span className="font-medium">{tp.private}</span>
              <span className="text-xs text-muted-foreground">{tp.privateHint}</span>
            </Option>
          </>
        ) : null}
      </RadioGroup>
    </fieldset>
  );
}
