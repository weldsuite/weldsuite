import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payment-runs/page';

export const Route = createFileRoute('/weldbooks/payment-runs/')({
  component: PageComponent,
});
