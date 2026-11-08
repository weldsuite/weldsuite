import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/teams/page';

export const Route = createFileRoute('/settings/apps/welddesk/teams/')({
  component: PageComponent,
});
