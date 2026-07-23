import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/teams/[id]/members/new/page';

export const Route = createFileRoute('/welddesk/teams/$id/members/new/')({
  component: PageComponent,
});
