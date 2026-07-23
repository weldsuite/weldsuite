import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/email/[id]/page';

export const Route = createFileRoute('/welddesk/inbox/email/$id/')({
  component: PageComponent,
});
