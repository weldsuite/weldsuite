import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/analytics/page';

export const Route = createFileRoute('/welddesk/reports/custom/')({
  component: PageComponent,
});
