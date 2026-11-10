import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/analytics/schedules/page';

export const Route = createFileRoute('/welddesk/reports/schedules')({
  component: PageComponent,
});
