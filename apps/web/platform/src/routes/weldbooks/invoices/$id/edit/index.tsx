import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/invoices/[id]/edit/page';

export const Route = createFileRoute('/weldbooks/invoices/$id/edit/')({
  component: PageComponent,
});
