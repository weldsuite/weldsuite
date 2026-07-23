import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/teams/support/page';

export const Route = createFileRoute('/welddesk/teams/support/')({
  component: PageComponent,
});
