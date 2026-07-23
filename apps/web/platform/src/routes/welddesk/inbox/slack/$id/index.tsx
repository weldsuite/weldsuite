import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/slack/[id]/page';

export const Route = createFileRoute('/welddesk/inbox/slack/$id/')({
  component: PageComponent,
});
