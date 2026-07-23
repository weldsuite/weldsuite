import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/analytics/[id]/page';

export const Route = createFileRoute('/welddesk/analytics/$id/')({
  component: PageComponent,
});
