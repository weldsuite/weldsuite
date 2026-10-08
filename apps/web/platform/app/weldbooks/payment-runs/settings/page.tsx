import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import { PaymentRunsFrame } from '../components/payment-runs-frame';
import { isPaymentBankAccount } from '../new/new-run-model';

/** The bank accounts a vendor payment can come from, each with the way to its payment settings. */
export default function PaymentSettingsListPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tl = tp.settings.list;
  const { data, isLoading, isError, refetch } = useBankAccounts();
  const accounts = useMemo(() => (data?.data ?? []).filter(isPaymentBankAccount), [data]);

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-destructive" role="alert">{tp.common.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>{tp.common.retry}</Button>
      </div>
    );
  } else if (accounts.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <Landmark className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="font-medium">{tl.emptyTitle}</p>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{tl.emptyDescription}</p>
          <Button asChild>
            <Link to="/weldbooks/banking">{tl.openBanking}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.map((account) => (
          <Card key={account.id}>
            <CardContent className="space-y-3 pt-6">
              <div>
                <p className="font-medium">{account.name}</p>
                <p className="text-sm text-muted-foreground">
                  {account.bankName ?? ''}
                  {account.accountNumberLast4 ? ` ····${account.accountNumberLast4}` : ''}
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link to="/weldbooks/payment-runs/settings/$bankAccountId" params={{ bankAccountId: account.id }}>
                  {tl.open}
                </Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <PaymentRunsFrame title={tl.title} subtitle={tl.subtitle}>
      {body}
    </PaymentRunsFrame>
  );
}
