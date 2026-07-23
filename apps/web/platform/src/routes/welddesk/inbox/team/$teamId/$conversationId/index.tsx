import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/team/[conversationId]/page';

export const Route = createFileRoute('/welddesk/inbox/team/$teamId/$conversationId/')({
  component: PageComponent,
});
