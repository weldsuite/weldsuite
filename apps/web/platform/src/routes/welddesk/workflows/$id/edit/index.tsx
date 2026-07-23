import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/workflows/[id]/edit/page';

export const Route = createFileRoute('/welddesk/workflows/$id/edit/')({
  component: PageComponent,
});
