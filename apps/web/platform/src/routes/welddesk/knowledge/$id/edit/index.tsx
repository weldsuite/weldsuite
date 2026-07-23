import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/knowledge/[id]/edit/page';

export const Route = createFileRoute('/welddesk/knowledge/$id/edit/')({
  component: PageComponent,
});
