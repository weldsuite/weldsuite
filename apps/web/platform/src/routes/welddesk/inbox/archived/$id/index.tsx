import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/archived/[id]/page';

export const Route = createFileRoute('/welddesk/inbox/archived/$id/')({
  component: PageComponent,
});
