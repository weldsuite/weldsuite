import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/tickets/new/page';

export const Route = createFileRoute('/welddesk/tickets/new/')({
  component: PageComponent,
});
