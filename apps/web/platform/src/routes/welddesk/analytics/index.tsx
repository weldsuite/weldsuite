import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/analytics/page';

export const Route = createFileRoute('/welddesk/analytics/')({
  component: PageComponent,
});
