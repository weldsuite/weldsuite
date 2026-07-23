import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/teams/support/members/[id]/page';

export const Route = createFileRoute('/welddesk/teams/support/members/$id/')({
  component: PageComponent,
});
