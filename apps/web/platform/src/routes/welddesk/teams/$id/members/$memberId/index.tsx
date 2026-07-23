import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/teams/[id]/members/[memberId]/page';

export const Route = createFileRoute('/welddesk/teams/$id/members/$memberId/')({
  component: PageComponent,
});
