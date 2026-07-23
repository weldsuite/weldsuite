import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/all/[conversationId]/page';

export const Route = createFileRoute('/welddesk/inbox/all/$conversationId/')({
  component: PageComponent,
});
