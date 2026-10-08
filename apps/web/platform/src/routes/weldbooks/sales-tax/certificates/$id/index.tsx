import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/certificates/[id]/page';

export const Route = createFileRoute('/weldbooks/sales-tax/certificates/$id/')({
  component: PageComponent,
});
