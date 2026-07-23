import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/invoices/page';

export const Route = createFileRoute('/weldbooks/invoices/')({
  component: PageComponent,
});
