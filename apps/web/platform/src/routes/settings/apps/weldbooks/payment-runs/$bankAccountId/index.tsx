import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/weldbooks/payment-runs/bank-account-page';

export const Route = createFileRoute('/settings/apps/weldbooks/payment-runs/$bankAccountId/')({
  component: PageComponent,
});
