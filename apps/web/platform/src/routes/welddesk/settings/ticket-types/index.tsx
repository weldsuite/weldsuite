import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/ticket-types/page';

export const Route = createFileRoute('/welddesk/settings/ticket-types/')({
  component: PageComponent,
});
