import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/agencies/page';

export const Route = createFileRoute('/weldbooks/sales-tax/agencies/')({
  component: PageComponent,
});
