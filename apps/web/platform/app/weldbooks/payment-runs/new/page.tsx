import { useI18n } from '@/lib/i18n/provider';
import { PaymentRunsFrame } from '../components/payment-runs-frame';
import { NewRunWizard } from './new-run-wizard';

export default function NewPaymentRunPage() {
  const { t } = useI18n();
  const tw = t.weldbooksUs.payments.wizard;
  return (
    <PaymentRunsFrame title={tw.title} subtitle={tw.subtitle}>
      <NewRunWizard />
    </PaymentRunsFrame>
  );
}
