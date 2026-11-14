import { CheckCircle2, CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useNavigate } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachBillingSummary } from '@weldsuite/app-api-client/schemas/reach';
import { inboxPrice } from '@/lib/reach/inbox-price';
import { useReachFormat } from '@/lib/reach/format';
import { usePaymentMethodSetup } from '../components/use-payment-method-setup';
import { StepFooter, StepFrame } from './setup-shell';

export function PaymentStep({
  billing,
  canUpdate,
  onBack,
  onNext,
  onSkip,
}: Readonly<{
  billing: ReachBillingSummary;
  canUpdate: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}>) {
  const t = useTranslations();
  const format = useReachFormat();
  const paymentSetup = usePaymentMethodSetup('/weldreach/setup', { step: 'payment' });
  const navigate = useNavigate();
  const unitPrice = inboxPrice();
  // Inboxes on the plan's Mollie charge (EU) need a paid plan, not a card.
  const needsPlan = unitPrice.withPlan && billing.status === 'none';
  let buttonLabel = t('reach.setup.payment.add');
  if (paymentSetup.isPending) buttonLabel = t('reach.setup.payment.redirecting');
  else if (billing.hasPaymentMethod) buttonLabel = t('reach.settings.billing.update');
  const price = format.money(billing.unitAmountCents || unitPrice.cents, billing.currency || unitPrice.currency);
  const description = unitPrice.withPlan ? 'reach.setup.payment.descriptionWithPlan' : 'reach.setup.payment.description';

  return (
    <StepFrame title={t('reach.setup.payment.title')} description={t(description, { price })}>
      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">{t('reach.setup.payment.priceLabel')}</span>
          <span className="text-lg font-semibold">{t('reach.setup.payment.priceValue', { price })}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t('reach.setup.payment.priceNote')}</p>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          {needsPlan && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CreditCard className="h-4 w-4" aria-hidden />
              {t('reach.setup.payment.paidPlanRequired')}
            </p>
          )}
          {!needsPlan && billing.hasPaymentMethod && (
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {t('reach.setup.payment.onFile')}
            </p>
          )}
          {!needsPlan && !billing.hasPaymentMethod && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CreditCard className="h-4 w-4" aria-hidden />
              {t('reach.setup.payment.missing')}
            </p>
          )}
          {needsPlan && (
            <Button size="sm" onClick={() => void navigate({ to: '/settings/plans' })}>
              {t('reach.mailboxes.create.seePlans')}
            </Button>
          )}
          {!needsPlan && canUpdate && (
            <Button
              variant={billing.hasPaymentMethod ? 'outline' : 'default'}
              size="sm"
              disabled={paymentSetup.isPending}
              onClick={() => void paymentSetup.start()}
            >
              {paymentSetup.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {buttonLabel}
            </Button>
          )}
        </div>
      </div>

      <StepFooter
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!billing.hasPaymentMethod}
        onSkip={billing.hasPaymentMethod ? undefined : onSkip}
      />
    </StepFrame>
  );
}
