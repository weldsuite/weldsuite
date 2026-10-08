import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/certificates/page';

export const Route = createFileRoute('/weldbooks/sales-tax/certificates/')({
  component: PageComponent,
});
