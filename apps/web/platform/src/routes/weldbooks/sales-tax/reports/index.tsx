import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/reports/page';

export const Route = createFileRoute('/weldbooks/sales-tax/reports/')({
  component: PageComponent,
});
