import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/slack/page';

export const Route = createFileRoute('/welddesk/inbox/slack/')({
  component: PageComponent,
});
