import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payment-runs/settings/[bankAccountId]/page';

export const Route = createFileRoute('/weldbooks/payment-runs/settings/$bankAccountId/')({
  component: PageComponent,
});
