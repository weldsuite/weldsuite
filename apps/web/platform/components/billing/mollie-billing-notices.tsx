import { format as formatDate } from 'date-fns';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { formatBillingAmount } from '@/app/settings/billing/billing-details';
import type {
  BillingOutstanding,
  BillingPaymentMethodRequired,
  BillingScheduledChange,
} from '@/lib/api/domains/billing';
import { PaymentMethodNeededBanner } from './payment-method-needed-banner';

const DATE_FORMAT = 'do MMM yyyy';

/**
 * Mollie plan billing notices on the billing page: a plan without a payment
 * method to renew on (before the renewal and through the grace period, for
 * whoever may add one), a past-due charge with a link to pay it, and a plan
 * change that waits for the period end. All come with the subscription and
 * are absent on Stripe.
 */
export function MollieBillingNotices({
  outstanding,
  scheduledChange,
  paymentMethodRequired,
  planName,
  canPay,
}: Readonly<{
  outstanding?: BillingOutstanding | null;
  scheduledChange?: BillingScheduledChange | null;
  paymentMethodRequired?: BillingPaymentMethodRequired | null;
  /** The plan that is renewed, for the payment-method notice. */
  planName?: string;
  /** Whether the viewer may pay and add a payment method (`billing:manage`). */
  canPay: boolean;
}>) {
  const { t, language, format } = useI18n();
  const ts = t.settings.billing.mollie;
  const methodNeeded = canPay ? paymentMethodRequired : null;
  // A renewal refused for want of a payment method: its notice offers paying
  // the open amount too, so the past-due one would only repeat it.
  const showOutstanding = outstanding && !methodNeeded?.pastDue;
  if (!methodNeeded && !showOutstanding && !scheduledChange) return null;

  return (
    <div className="space-y-3">
      {methodNeeded && (
        <PaymentMethodNeededBanner
          required={methodNeeded}
          planName={planName ?? ''}
          payUrl={outstanding?.payUrl}
        />
      )}
      {showOutstanding && (
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
