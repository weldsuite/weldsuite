import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/sales-tax/certificate-reports/page';

export const Route = createFileRoute('/weldbooks/sales-tax/certificates/reports/')({
  component: PageComponent,
});
