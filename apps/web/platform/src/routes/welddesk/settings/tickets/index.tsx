import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/tickets/page';

export const Route = createFileRoute('/welddesk/settings/tickets/')({
  component: PageComponent,
});
