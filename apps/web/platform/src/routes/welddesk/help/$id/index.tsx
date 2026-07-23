import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/help/[id]/page';

export const Route = createFileRoute('/welddesk/help/$id/')({
  component: PageComponent,
});
