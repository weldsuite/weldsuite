import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/teams/[id]/page';

export const Route = createFileRoute('/welddesk/teams/$id/')({
  component: PageComponent,
});
