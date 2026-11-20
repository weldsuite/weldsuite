import { Badge } from '@weldsuite/ui/components/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useI18n } from '@/lib/i18n/provider';
import { formatBillingAmount } from './billing-details';

/** A package of `GET /credits/packages`. */
export interface CreditPackageOption {
  id: string;
  name: string;
  description?: string | null;
  credits: number;
  price: number;
  currency: string;
  isPopular?: boolean;
}

interface BuyCreditsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balance: number;
  packages: CreditPackageOption[];
  /** A checkout is being started: the packages are disabled. */
  pending: boolean;
  onBuy: (packageId: string) => void;
  /** A line under the packages about their prices (excl. VAT with plan billing on Mollie). */
  priceNote?: string;
}

/**
 * Pick a credit package; buying it goes to the hosted checkout (Stripe on
 * Global, Mollie on the Kubernetes editions).
 */
export function BuyCreditsDialog({ open, onOpenChange, balance, packages, pending, onBuy, priceNote }: Readonly<BuyCreditsDialogProps>) {
  const { t, language } = useI18n();
  const ts = t.settings.billing.creditsWallet;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{ts.choosePackage}</DialogTitle>
        </DialogHeader>

        <div className="py-2">
          <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3 mb-4">
            <span className="text-sm text-muted-foreground">{ts.currentBalance}</span>
            <span className="text-sm font-semibold">
              {balance.toLocaleString()} {ts.creditsUnit}
            </span>
          </div>

          {packages.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">{ts.noPackages}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {packages.map((pkg) => (
                <button
                  key={pkg.id}
                  type="button"
                  disabled={pending}
                  onClick={() => onBuy(pkg.id)}
                  className="relative flex flex-col items-start rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-muted/40 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {pkg.isPopular && (
                    <Badge className="absolute top-3 right-3 rounded-sm text-[10px]">{ts.popular}</Badge>
                  )}
                  <span className="text-lg font-semibold">
                    {pkg.credits.toLocaleString()}
                    <span className="text-xs font-normal text-muted-foreground ml-1">{ts.creditsUnit}</span>
                  </span>
                  <span className="text-sm text-muted-foreground mt-1">
                    {formatBillingAmount(Math.round(pkg.price * 100), pkg.currency, language)}
                  </span>
                  {pkg.description && (
                    <span className="text-xs text-muted-foreground mt-2">{pkg.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {priceNote && packages.length > 0 && (
            <p className="text-xs text-muted-foreground mt-4">{priceNote}</p>
          )}

          {pending && (
            <p className="text-xs text-muted-foreground text-center mt-4">{ts.redirecting}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
