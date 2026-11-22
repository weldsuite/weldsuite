import { useState } from 'react';
import { toast } from 'sonner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Button } from '@weldsuite/ui/components/button';
import { usePermissions } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import { usePathname } from '@/lib/router';
import { billingProvider } from '@/lib/edition';
import { useCreateSetupIntent, useSubscription } from '@/hooks/queries/use-billing-queries';
import type { BillingPaymentMethodRequired } from '@/lib/api/domains/billing';

/** `14 December 2026` / `14 december 2026`, as the billing emails write it. */
export function formatDueDate(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language === 'nl' ? 'nl-NL' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
}

/**
 * A paid plan with no payment method to charge on Mollie (ADR BILL-014):
 * every workspace that moved from Global arrives without one. Shown to members
 * who manage billing from 14 days before the renewal through the grace period
 * (`paymentMethodRequired` on the subscription): what is needed, by when, and
 * the button that starts adding one (a Mollie checkout that saves a card, then
 * back to the billing page). Once the renewal was refused, `payUrl` offers
 * paying the open amount instead, which saves the payment method too.
 */
export function PaymentMethodNeededBanner({
  required,
  planName,
  payUrl,
  dismissible = false,
  onDismiss,
  className,
}: Readonly<{
  required: BillingPaymentMethodRequired;
  planName: string;
  /** The open charge's pay link, while the plan runs on its grace period. */
  payUrl?: string | null;
  dismissible?: boolean;
  onDismiss?: () => void;
  className?: string;
}>) {
  const { t, language, format } = useI18n();
  const ts = t.settings.billing.mollie;
  const createSetupIntent = useCreateSetupIntent();
  const date = formatDueDate(required.dueAt, language);
  const values = { date, plan: planName };

  const addPaymentMethod = async () => {
    try {
      const { url } = await createSetupIntent.mutateAsync();
      if (url) {
        window.location.href = url;
        return;
      }
    } catch {
      // Falls through to the shared failure message.
    }
    toast.error(t.settings.billing.paymentMethods.addFailed);
  };

  return (
    <InfoBanner
      variant={required.pastDue ? 'danger' : 'warning'}
      title={required.pastDue ? ts.methodNeededPastDueTitle : format(ts.methodNeededTitle, values)}
      dismissible={dismissible}
      onDismiss={onDismiss}
      className={className}
      data-testid="payment-method-needed-banner"
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void addPaymentMethod()} disabled={createSetupIntent.isPending}>
            {ts.addPaymentMethod}
          </Button>
          {required.pastDue && payUrl && (
            <Button size="sm" variant="outline" asChild>
              <a href={payUrl}>{ts.payNow}</a>
            </Button>
          )}
        </div>
      }
    >
      {format(required.pastDue ? ts.methodNeededPastDueBody : ts.methodNeededBody, values)}
    </InfoBanner>
  );
}

const DISMISS_KEY = 'weldsuite:payment-method-needed-dismissed';

function dismissedFor(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    // sessionStorage unavailable: the notice shows on every page load.
    return null;
  }
}

function rememberDismissed(key: string): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, key);
  } catch {
    // Non-fatal: the notice comes back on the next page load.
  }
}

/**
 * The same notice in the app shell, floating at the bottom so it never changes
 * the height module pages are laid out in. Only on the Mollie edition, only for
 * members who manage billing, and not on the billing page, which shows its own.
 * Dismissed for the browser session; a new due date (the renewal was refused)
 * brings it back.
 */
export function PaymentMethodNeededNotice() {
  const { can } = usePermissions();
  const pathname = usePathname();
  const isMollie = billingProvider() === 'mollie';
  const { data: subscription } = useSubscription();
  const [dismissedNow, setDismissedNow] = useState<string | null>(null);

  const required = isMollie ? subscription?.paymentMethodRequired : null;
  if (!required || !can('billing:manage')) return null;
  if (pathname?.endsWith('/settings/billing')) return null;
  const key = `${required.dueAt}:${required.pastDue ? 'past-due' : 'upcoming'}`;
  if (dismissedNow === key || dismissedFor() === key) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <PaymentMethodNeededBanner
        required={required}
        planName={subscription?.planName ?? ''}
        payUrl={subscription?.outstanding?.payUrl}
        dismissible
        onDismiss={() => {
          rememberDismissed(key);
          setDismissedNow(key);
        }}
        className="pointer-events-auto w-full max-w-2xl shadow-lg"
      />
    </div>
  );
}
