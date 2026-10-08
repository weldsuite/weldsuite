import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payment-runs/positive-pay/page';

export const Route = createFileRoute('/weldbooks/payment-runs/positive-pay/')({
  component: PageComponent,
});
