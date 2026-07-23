import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/reports/aged-receivables/page';

export const Route = createFileRoute('/weldbooks/reports/aged-receivables/')({
  component: PageComponent,
});
