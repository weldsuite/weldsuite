import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/news/[id]/page';

export const Route = createFileRoute('/welddesk/news/$id/')({
  component: PageComponent,
});
