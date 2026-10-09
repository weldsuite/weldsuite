import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payment-runs/new/page';

export const Route = createFileRoute('/weldbooks/payment-runs/new/')({
  component: PageComponent,
});
