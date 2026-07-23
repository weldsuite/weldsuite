import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/tickets/page';

export const Route = createFileRoute('/welddesk/tickets/')({
  component: PageComponent,
});
