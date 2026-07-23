import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/knowledge/[id]/page';

export const Route = createFileRoute('/welddesk/knowledge/$id/')({
  component: PageComponent,
});
