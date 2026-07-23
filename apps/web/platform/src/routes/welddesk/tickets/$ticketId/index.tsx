import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/tickets/[ticketId]/page';

export const Route = createFileRoute('/welddesk/tickets/$ticketId/')({
  component: PageComponent,
});
