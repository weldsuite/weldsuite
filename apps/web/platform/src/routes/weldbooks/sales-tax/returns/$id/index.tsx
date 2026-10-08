import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/returns/[id]/page';

export const Route = createFileRoute('/weldbooks/sales-tax/returns/$id/')({
  component: PageComponent,
});
