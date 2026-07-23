import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/teams/[id]/edit/page';

export const Route = createFileRoute('/welddesk/teams/$id/edit/')({
  component: PageComponent,
});
