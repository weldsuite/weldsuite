import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/reports/aged-payables/page';

export const Route = createFileRoute('/weldbooks/reports/aged-payables/')({
  component: PageComponent,
});
