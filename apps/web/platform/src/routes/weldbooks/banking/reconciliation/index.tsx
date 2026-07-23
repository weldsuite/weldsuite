import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/reconciliation/page';

export const Route = createFileRoute('/weldbooks/banking/reconciliation/')({
  component: PageComponent,
});
