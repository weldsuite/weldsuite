import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/page';

export const Route = createFileRoute('/weldbooks/sales-tax/')({
  component: PageComponent,
});
