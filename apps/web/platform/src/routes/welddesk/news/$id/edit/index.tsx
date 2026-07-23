import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/news/[id]/edit/page';

export const Route = createFileRoute('/welddesk/news/$id/edit/')({
  component: PageComponent,
});
