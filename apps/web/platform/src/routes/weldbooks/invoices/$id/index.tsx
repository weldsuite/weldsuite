import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/invoices/[id]/page';

export const Route = createFileRoute('/weldbooks/invoices/$id/')({
  component: PageComponent,
});
