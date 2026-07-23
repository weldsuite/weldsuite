import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/transactions/page';

export const Route = createFileRoute('/weldbooks/banking/transactions/')({
  component: PageComponent,
});
