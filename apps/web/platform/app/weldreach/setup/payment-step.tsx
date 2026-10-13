import { CheckCircle2, CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  WELDREACH_INBOX_CURRENCY,
  WELDREACH_INBOX_PRICE_CENTS,
  type ReachBillingSummary,
} from '@weldsuite/app-api-client/schemas/reach';
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
  let buttonLabel = t('reach.setup.payment.add');
  if (paymentSetup.isPending) buttonLabel = t('reach.setup.payment.redirecting');
  else if (billing.hasPaymentMethod) buttonLabel = t('reach.settings.billing.update');
  const price = format.money(billing.unitAmountCents || WELDREACH_INBOX_PRICE_CENTS, billing.currency || WELDREACH_INBOX_CURRENCY);

  return (
    <StepFrame title={t('reach.setup.payment.title')} description={t('reach.setup.payment.description', { price })}>
      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">{t('reach.setup.payment.priceLabel')}</span>
          <span className="text-lg font-semibold">{t('reach.setup.payment.priceValue', { price })}</span>
        </div>
        <p className="text-xs text-muted-foreground">{t('reach.setup.payment.priceNote')}</p>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          {billing.hasPaymentMethod ? (
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              {t('reach.setup.payment.onFile')}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CreditCard className="h-4 w-4" aria-hidden />
              {t('reach.setup.payment.missing')}
            </p>
          )}
          {canUpdate && (
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
