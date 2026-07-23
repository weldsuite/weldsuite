import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/announcements/[id]/page';

export const Route = createFileRoute('/welddesk/announcements/$id/')({
  component: PageComponent,
});
