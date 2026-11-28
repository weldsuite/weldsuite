/**
 * "Transfer between accounts": the counterparty IBAN of the line is checked
 * against the entity's other accounts and that account is preselected;
 * otherwise the person picks one.
 */

import { Loader2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { BankLine } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { isPaymentProviderAccount } from '@/lib/weldbooks/online-payments';
import { ownAccountForLine, transferTargets } from './process-model';

interface OwnAccount {
  id: string;
  name: string;
  iban: string | null;
  /** `payment_provider` for the Mollie money account. */
  accountType?: string | null;
}

export interface TransferFormProps {
  line: BankLine;
  accounts: readonly OwnAccount[];
  pending: boolean;
  errorMessage: string | null;
  onSubmit: (bankAccountId: string | undefined) => void;
  onCancel: () => void;
}

export function TransferForm({ line, accounts, pending, errorMessage, onSubmit, onCancel }: Readonly<TransferFormProps>) {
  const { t } = useI18n();
  const tt = t.weldbooksConnected.processing.transfer;
  const ids = useId();
  const matched = ownAccountForLine(line, accounts);
  const [accountId, setAccountId] = useState(matched?.id ?? '');
  // Mollie's money account is offered only for a payout line, not as a bank to move money to.
  const others = transferTargets(line, accounts);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pending) onSubmit(accountId || undefined);
  };

  return (
    <form onSubmit={submit} aria-labelledby={`${ids}-title`} className="space-y-3 rounded-xl border p-5" data-testid="transfer-form">
      <div>
        <h3 id={`${ids}-title`} className="text-sm font-semibold">
          {tt.title}
        </h3>
        <p className="text-xs text-muted-foreground">{tt.hint}</p>
      </div>
      {matched ? (
        <p className="text-sm" data-testid="transfer-matched">
          {tt.matched.replace('{name}', matched.name)}
        </p>
      ) : null}
      {others.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor={`${ids}-account`}>{tt.accountLabel}</Label>
          <Select value={accountId} onValueChange={(next) => next && setAccountId(next)}>
            <SelectTrigger id={`${ids}-account`} className="w-full sm:w-80">
              <SelectValue placeholder={tt.accountPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {others.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {isPaymentProviderAccount(account)
                    ? t.weldbooksPayments.bankAccount.providerOption.replace('{name}', account.name)
                    : account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {errorMessage ? (
        <p className="text-sm text-destructive" role="alert" data-testid="transfer-error">
          {errorMessage}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending} data-testid="transfer-submit">
          {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
          {tt.book}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t.weldbooksConnected.processing.category.cancel}
        </Button>
      </div>
    </form>
  );
}
