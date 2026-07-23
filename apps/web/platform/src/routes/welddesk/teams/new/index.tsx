import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/teams/new/page';

export const Route = createFileRoute('/welddesk/teams/new/')({
  component: PageComponent,
});
