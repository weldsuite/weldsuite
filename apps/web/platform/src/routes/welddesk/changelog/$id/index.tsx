import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/changelog/[id]/page';

export const Route = createFileRoute('/welddesk/changelog/$id/')({
  component: PageComponent,
});
