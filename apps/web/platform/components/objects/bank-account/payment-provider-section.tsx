/**
 * The "Payment provider" part of a bank account panel (WeldBooks online
 * payments, edition feature `books-online-payments`): what the Mollie money
 * account is, and "Sync payouts" when the connection can read them. Shown only
 * for an account of type `payment_provider`.
 */

import { useState } from 'react';
import { CreditCard, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { usePaymentConnection, useSyncSettlements } from '@/hooks/queries/use-weldbooks-payments-queries';
import { paymentErrorCode } from '@/lib/api/domains/weldbooks-payments';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

export function PaymentProviderSection({ accountId }: Readonly<{ accountId: string }>) {
  const { t } = useI18n();
  const copy = t.weldbooksPayments;
  const canSync = useCan('accounts:update');
  const connection = usePaymentConnection();
  const sync = useSyncSettlements();
  const [summary, setSummary] = useState<string | null>(null);

  // The sync belongs to the connection whose money account this is.
  const current = connection.data?.bankAccountId === accountId ? connection.data : null;
  const canRun = canSync && current?.settlementsAvailable === true && current.status === 'active';

  const run = () => {
    if (!current) return;
    setSummary(null);
    sync.mutate(current.id, {
      onSuccess: (res) => {
        const result = res.data;
        setSummary(
          copy.settings.sync.result
            .replace('{imported}', String(result.imported))
            .replace('{skipped}', String(result.skipped))
            .replace('{booked}', String(result.booked))
            .replace('{lines}', String(result.lines))
            .replace('{toProcess}', String(result.toProcess))
            .replace('{payouts}', String(result.payouts))
            .replace('{fees}', String(result.fees)),
        );
        toast.success(copy.settings.sync.done);
      },
      onError: (error) =>
        toast.error(copy.settings.sync.failed, {
          description:
            paymentErrorCode(error) === 'SETTLEMENTS_UNAVAILABLE'
              ? copy.settings.sync.refused
              : error instanceof Error
                ? error.message
                : undefined,
        }),
    });
  };

  return (
    <section
      aria-label={copy.bankAccount.providerLabel}
      className="space-y-2 rounded-lg border border-border p-3"
      data-testid="payment-provider-section"
    >
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden />
        {copy.bankAccount.providerLabel}
      </h3>
      <p className="text-[13px] text-muted-foreground">{copy.bankAccount.providerHint}</p>
      {canRun ? (
        <Button type="button" variant="outline" size="sm" onClick={run} disabled={sync.isPending} data-testid="sync-payouts">
          <RefreshCw className={cn('h-4 w-4', sync.isPending && 'animate-spin')} aria-hidden />
          {sync.isPending ? copy.bankAccount.syncing : copy.bankAccount.syncPayouts}
        </Button>
      ) : null}
      <div role="status">{summary ? <p className="text-[13px]">{summary}</p> : null}</div>
    </section>
  );
}
