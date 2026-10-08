import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payment-runs/[id]/checks/page';

export const Route = createFileRoute('/weldbooks/payment-runs/$id/checks/')({
  component: PageComponent,
});
