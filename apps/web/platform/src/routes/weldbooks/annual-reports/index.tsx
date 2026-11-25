import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/annual-reports/page';

export const Route = createFileRoute('/weldbooks/annual-reports/')({
  component: PageComponent,
});
