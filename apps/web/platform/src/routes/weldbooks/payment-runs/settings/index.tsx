import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payment-runs/settings/page';

export const Route = createFileRoute('/weldbooks/payment-runs/settings/')({
  component: PageComponent,
});
