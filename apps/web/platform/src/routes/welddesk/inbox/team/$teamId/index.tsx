import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/team/page';

export const Route = createFileRoute('/welddesk/inbox/team/$teamId/')({
  component: PageComponent,
});
