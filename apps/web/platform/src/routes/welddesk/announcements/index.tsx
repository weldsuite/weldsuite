import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/announcements/page';

export const Route = createFileRoute('/welddesk/announcements/')({
  component: PageComponent,
});
