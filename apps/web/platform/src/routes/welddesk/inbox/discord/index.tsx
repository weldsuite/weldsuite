import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/discord/page';

export const Route = createFileRoute('/welddesk/inbox/discord/')({
  component: PageComponent,
});
