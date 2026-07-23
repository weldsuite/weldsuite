import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/announcements/new/page';

export const Route = createFileRoute('/welddesk/announcements/new/')({
  component: PageComponent,
});
