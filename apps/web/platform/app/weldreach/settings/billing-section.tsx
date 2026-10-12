/**
 * Billing summary: mailboxes x price, status (a failed payment is called out),
 * whether a payment method is on file, and "Update payment method", which goes
 * through Stripe Checkout in setup mode.
 */

import { CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ReachBillingSummary } from '@weldsuite/app-api-client/schemas/reach';
import { SoftBadge, type SoftTone } from '@/components/shared/soft-badge';
import { useReachBilling } from '@/hooks/queries/use-reach-queries';
import { useReachFormat } from '@/lib/reach/format';
import { ErrorPanel, SectionCard } from '../components/page-kit';
import { usePaymentMethodSetup } from '../components/use-payment-method-setup';

const STATUS_TONE: Record<ReachBillingSummary['status'], SoftTone> = {
  none: 'neutral',
  active: 'success',
  past_due: 'danger',
  canceled: 'neutral',
};

export function BillingSection() {
  const t = useTranslations();
  const format = useReachFormat();
  const { can } = usePermissions();
  const canUpdate = can('reach_settings:update');
  const billing = useReachBilling(can('reach_settings:read'));
  const paymentSetup = usePaymentMethodSetup('/weldreach/settings');

  return (
    <SectionCard title={t('reach.settings.billing.title')} description={t('reach.settings.billing.description')}>
      {billing.isPending && (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('reach.common.loading')}
        </div>
      )}
      {billing.isError && <ErrorPanel onRetry={() => void billing.refetch()} />}
      {billing.data && (
        <div className="space-y-5">
          {billing.data.status === 'past_due' && (
            <InfoBanner variant="warning" title={t('reach.settings.billing.pastDueTitle')}>
              {t('reach.settings.billing.pastDueDescription')}
            </InfoBanner>
          )}

          <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t('reach.settings.billing.status')}</dt>
              <dd>
                <SoftBadge tone={STATUS_TONE[billing.data.status]}>{t(`reach.status.billing.${billing.data.status}`)}</SoftBadge>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t('reach.settings.billing.paymentMethod')}</dt>
              <dd className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden />
                {billing.data.hasPaymentMethod ? t('reach.settings.billing.onFile') : t('reach.settings.billing.notOnFile')}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t('reach.settings.billing.inboxes')}</dt>
              <dd className="font-medium tabular-nums">
                {t('reach.settings.billing.inboxesValue', {
                  count: billing.data.inboxCount,
                  price: format.money(billing.data.unitAmountCents, billing.data.currency),
                })}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t('reach.settings.billing.monthly')}</dt>
              <dd className="font-medium tabular-nums">
                {format.money(billing.data.inboxCount * billing.data.unitAmountCents, billing.data.currency)}
              </dd>
            </div>
            {billing.data.currentPeriodEnd && (
              <div className="space-y-1">
                <dt className="text-muted-foreground">{t('reach.settings.billing.nextInvoice')}</dt>
                <dd>{format.date(billing.data.currentPeriodEnd)}</dd>
              </div>
            )}
          </dl>

          {canUpdate && (
            <Button variant="outline" size="sm" disabled={paymentSetup.isPending} onClick={() => void paymentSetup.start()}>
              {paymentSetup.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {billing.data.hasPaymentMethod ? t('reach.settings.billing.update') : t('reach.settings.billing.add')}
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}
