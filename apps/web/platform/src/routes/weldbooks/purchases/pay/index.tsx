import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/purchases/pay/page';

export const Route = createFileRoute('/weldbooks/purchases/pay/')({
  component: PageComponent,
});
