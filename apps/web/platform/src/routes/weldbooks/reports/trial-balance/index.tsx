import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/reports/trial-balance/page';

export const Route = createFileRoute('/weldbooks/reports/trial-balance/')({
  component: PageComponent,
});
