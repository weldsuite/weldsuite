import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/email/page';

export const Route = createFileRoute('/welddesk/inbox/email/')({
  component: PageComponent,
});
