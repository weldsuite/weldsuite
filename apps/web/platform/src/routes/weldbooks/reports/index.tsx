import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/reports/page';

export const Route = createFileRoute('/weldbooks/reports/')({
  component: PageComponent,
});
