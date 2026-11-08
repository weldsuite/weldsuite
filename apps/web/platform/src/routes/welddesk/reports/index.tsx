import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/analytics/overview/page';

export const Route = createFileRoute('/welddesk/reports/')({
  component: PageComponent,
});
