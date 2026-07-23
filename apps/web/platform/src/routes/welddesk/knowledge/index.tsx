import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/knowledge/page';

export const Route = createFileRoute('/welddesk/knowledge/')({
  component: PageComponent,
});
