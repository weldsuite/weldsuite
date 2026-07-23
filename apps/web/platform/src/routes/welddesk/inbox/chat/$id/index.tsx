import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/chat/[id]/page';

export const Route = createFileRoute('/welddesk/inbox/chat/$id/')({
  component: PageComponent,
});
