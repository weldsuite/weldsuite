import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/assignment/page';

export const Route = createFileRoute('/settings/apps/welddesk/assignment/')({
  component: PageComponent,
});
