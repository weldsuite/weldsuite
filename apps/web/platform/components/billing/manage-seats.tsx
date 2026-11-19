import { useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Loader2, Minus, Plus } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useSeatPrice, useUpdateSeats } from '@/hooks/queries/use-billing-queries';
import type { Billing } from '@/lib/api/types/apps/billing.types';
import { formatPlanPrice } from '@/components/settings/plan-pricing';

/** What the seats dialog shows of the subscription: Global's and Mollie's both fit. */
export interface SeatsSubscription {
  planName: string;
  purchasedSeats: number;
  cycle?: string;
}

export function ManageSeatsDialog({
  open,
  onOpenChange,
  subscription,
  planLimits,
  seatCount,
  onSeatCountChange,
  min,
  max,
  perSeatPrice,
  currency,
  interval,
  processing,
  onConfirm,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: SeatsSubscription | null;
  planLimits: Billing.PlanLimits | null;
  seatCount: number;
  onSeatCountChange: (count: number) => void;
  min: number;
  max: number | undefined;
  /** Per seat per `interval`, in cents. */
  perSeatPrice: number;
  currency: string;
  interval: 'month' | 'year';
  processing: boolean;
  onConfirm: () => void;
}>) {
  const t = useTranslations();
  // Shown per month; an annual price as its monthly equivalent, billed annually.
  const isAnnual = interval === 'year';
  const perSeatMonthly = isAnnual ? Math.round(perSeatPrice / 12) : perSeatPrice;
  const totalMonthly = isAnnual ? Math.round((seatCount * perSeatPrice) / 12) : seatCount * perSeatPrice;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sweep.settings.billing.manageSeatsDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('sweep.settings.billing.manageSeatsDialog.description', { name: subscription?.planName })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Seat counter */}
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div>
              <p className="font-medium">{t('sweep.settings.billing.seats')}</p>
              <p className="text-sm text-muted-foreground">
                {t('sweep.settings.billing.manageSeatsDialog.currentlyInUse', { count: planLimits?.currentUsage.memberCount || 0 })}
              </p>
            </div>
            <div className="flex items-center border rounded-md overflow-hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => onSeatCountChange(Math.max(min, seatCount - 1))}
                disabled={seatCount <= min}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-8 text-center text-sm font-medium">{seatCount}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => onSeatCountChange(max ? Math.min(max, seatCount + 1) : seatCount + 1)}
                disabled={!!max && seatCount >= max}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Summary line */}
          {perSeatPrice > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('sweep.settings.billing.manageSeatsDialog.seatCount', { count: seatCount })} &times;{' '}
              {formatPlanPrice(perSeatMonthly, currency)}/{t('sweep.settings.billing.seat')} ={' '}
              <span className="font-medium text-foreground">
                {formatPlanPrice(totalMonthly, currency)}/{isAnnual ? t('sweep.settings.billing.monthBilledAnnually') : t('sweep.settings.billing.month')}
              </span>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={processing}>
            {t('sweep.settings.billing.cancel')}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={processing || seatCount === (subscription?.purchasedSeats || 0)}
          >
            {processing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('sweep.settings.billing.updateSeats')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Manage seats" for a running paid plan: the button and the dialog, priced
 * at what a seat costs on the running period (`GET /billing/seat-price`).
 * More seats are charged at once (Mollie: a prorated charge on the mandate,
 * or a hosted payment page); fewer take effect at the period end on Mollie
 * (ADR BILL-014, decision 7), which the toast says. The plan's maximum caps
 * the count; the server refuses fewer seats than members and invitations.
 */
export function ManageSeatsAction({
  subscription,
  planLimits,
  className,
}: Readonly<{
  subscription: SeatsSubscription | null;
  planLimits: Billing.PlanLimits | null;
  className?: string;
}>) {
  const t = useTranslations();
  const { t: i18n, format: fill } = useI18n();
  const [open, setOpen] = useState(false);
  const [seatCount, setSeatCount] = useState(1);
  const updateSeats = useUpdateSeats();
  const { data: seatPrice } = useSeatPrice(open);
  const min = Math.max(1, planLimits?.currentUsage.memberCount || 1);
  const max = planLimits?.maxMembers || undefined;

  const handleOpen = () => {
    setSeatCount(subscription?.purchasedSeats || min);
    setOpen(true);
  };

  const handleConfirm = async () => {
    try {
      const result = await updateSeats.mutateAsync({ seats: seatCount });
      if (result.paymentUrl) {
        // The added seats are paid on a hosted payment page first.
        window.location.href = result.paymentUrl;
        return;
      }
      if (result.effectiveAt) {
        toast.success(fill(i18n.settings.billing.mollie.seatsScheduled, { date: format(new Date(result.effectiveAt), 'do MMM yyyy') }));
      } else {
        toast.success(t('sweep.settings.billing.toasts.seatsUpdated', { count: seatCount }));
      }
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sweep.settings.billing.errors.updateSeatsFailed'));
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" className={className} onClick={handleOpen}>
        {t('sweep.settings.billing.manageSeatsButton')}
      </Button>
      <ManageSeatsDialog
        open={open}
        onOpenChange={setOpen}
        subscription={subscription}
        planLimits={planLimits}
        seatCount={seatCount}
        onSeatCountChange={setSeatCount}
        min={min}
        max={max}
        perSeatPrice={seatPrice?.amount ?? 0}
        currency={seatPrice?.currency ?? 'EUR'}
        interval={seatPrice?.interval ?? (subscription?.cycle === 'yearly' ? 'year' : 'month')}
        processing={updateSeats.isPending}
        onConfirm={() => void handleConfirm()}
      />
    </>
  );
}
