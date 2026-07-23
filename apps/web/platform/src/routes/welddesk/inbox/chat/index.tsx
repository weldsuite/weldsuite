import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/chat/page';

export const Route = createFileRoute('/welddesk/inbox/chat/')({
  component: PageComponent,
});
