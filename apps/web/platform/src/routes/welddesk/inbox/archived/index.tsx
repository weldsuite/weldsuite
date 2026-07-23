import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/inbox/archived/page';

export const Route = createFileRoute('/welddesk/inbox/archived/')({
  component: PageComponent,
});
