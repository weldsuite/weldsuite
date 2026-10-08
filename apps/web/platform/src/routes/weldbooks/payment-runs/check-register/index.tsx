import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payment-runs/check-register/page';

export const Route = createFileRoute('/weldbooks/payment-runs/check-register/')({
  component: PageComponent,
});
