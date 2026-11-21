import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { usePermissions } from '@weldsuite/permissions/react';
import { useTranslations } from '@weldsuite/i18n/client';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { useCreditPackages, useCreditsBalance, useBuyCredits } from '@/hooks/queries/use-billing-queries';
import { useI18n } from '@/lib/i18n/provider';
import { BuyCreditsDialog, type CreditPackageOption } from './buy-credits-dialog';
import { useCreditCheckoutReturn } from './credit-checkout-return';

/**
 * The billing page of an edition without plans or invoices (the Kubernetes
 * editions, where `billing` is unavailable): the prepaid credit balance and
 * its top-up, a Mollie payment (`credit-top-up`).
 */
export function CreditsWalletSettings() {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.billing.creditsWallet;
  const { can } = usePermissions();
  const canReadBilling = can('billing:read');
  const canManageBilling = can('billing:manage');

  const { data: balanceData, isLoading } = useCreditsBalance();
  const { data: packagesData } = useCreditPackages();
  const buyCredits = useBuyCredits();
  const [buyOpen, setBuyOpen] = useState(false);
  useCreditCheckoutReturn(ts);

  const wallet = (balanceData?.data as { currentBalance?: number; isLow?: boolean } | undefined) ?? null;
  const packages = (packagesData?.data as CreditPackageOption[] | undefined) ?? [];
  const balance = wallet?.currentBalance ?? 0;

  const handleBuy = async (packageId: string) => {
    try {
      const { url } = await buyCredits.mutateAsync(packageId);
      if (url) window.location.href = url;
      else toast.error(ts.purchaseFailed);
    } catch {
      toast.error(ts.purchaseFailed);
    }
  };

  if (!canReadBilling) {
    return (
      <AccessDeniedEmptyState
        description={st('sweep.settings.billingPage.accessDeniedDescription')}
        permission="billing:read"
        pageLabel={st('sweep.settings.billingPage.pageLabel')}
      />
    );
  }

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="space-y-10 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>

      <div className="border rounded-xl px-4 pt-3.5 pb-[18px] flex flex-col max-w-md">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">{ts.currentBalance}</span>
          {canManageBilling && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setBuyOpen(true)}>
              {ts.topUp}
            </Button>
          )}
        </div>
        <p className="text-lg font-semibold">
          {balance.toLocaleString()}
          <span className="text-sm font-normal text-muted-foreground ml-1">{ts.creditsUnit}</span>
        </p>
        {wallet?.currentBalance === 0 ? (
          <p className="text-xs text-muted-foreground mt-1">{ts.noCredits}</p>
        ) : wallet?.isLow && (
          <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-1">{ts.lowBalance}</p>
        )}
        {canManageBilling && <p className="text-xs text-muted-foreground mt-3">{ts.paidThroughMollie}</p>}
      </div>

      <BuyCreditsDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        balance={balance}
        packages={packages}
        pending={buyCredits.isPending}
        onBuy={(packageId) => void handleBuy(packageId)}
      />
    </div>
  );
}
