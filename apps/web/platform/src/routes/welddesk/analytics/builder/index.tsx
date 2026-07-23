import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/analytics/builder/page';

export const Route = createFileRoute('/welddesk/analytics/builder/')({
  component: PageComponent,
});
