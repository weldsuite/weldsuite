import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/teams/page';

export const Route = createFileRoute('/welddesk/teams/')({
  component: PageComponent,
});
