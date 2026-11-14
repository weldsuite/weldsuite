import { format as formatDate } from 'date-fns';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { formatBillingAmount } from '@/app/settings/billing/billing-details';
import type { BillingOutstanding, BillingScheduledChange } from '@/lib/api/domains/billing';

const DATE_FORMAT = 'do MMM yyyy';

/**
 * Mollie plan billing notices on the billing page: a past-due charge with a
 * link to pay it, and a plan change that waits for the period end. Both come
 * with the subscription and are absent on Stripe.
 */
export function MollieBillingNotices({
  outstanding,
  scheduledChange,
  canPay,
}: Readonly<{
  outstanding?: BillingOutstanding | null;
  scheduledChange?: BillingScheduledChange | null;
  /** Whether the viewer may pay (`billing:manage`). */
  canPay: boolean;
}>) {
  const { t, language, format } = useI18n();
  const ts = t.settings.billing.mollie;
  if (!outstanding && !scheduledChange) return null;

  return (
    <div className="space-y-3">
      {outstanding && (
        <InfoBanner
          variant="danger"
          title={ts.pastDueTitle}
          action={
            canPay ? (
              <Button size="sm" asChild>
                <a href={outstanding.payUrl}>{ts.payNow}</a>
              </Button>
            ) : undefined
          }
        >
          {format(ts.pastDueBody, {
            amount: formatBillingAmount(outstanding.amount, outstanding.currency, language),
            since: formatDate(new Date(outstanding.since), DATE_FORMAT),
          })}
        </InfoBanner>
      )}
      {scheduledChange && (
        <InfoBanner variant="info">
          {format(ts.scheduledChange, {
            date: formatDate(new Date(scheduledChange.effectiveAt), DATE_FORMAT),
            plan: scheduledChange.planName,
            seats: String(scheduledChange.seats),
            cycle: scheduledChange.cycle === 'yearly' ? ts.cycleYearly : ts.cycleMonthly,
          })}
        </InfoBanner>
      )}
    </div>
  );
}
