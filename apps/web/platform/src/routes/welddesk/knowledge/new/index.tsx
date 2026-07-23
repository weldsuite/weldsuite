import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/knowledge/new/page';

export const Route = createFileRoute('/welddesk/knowledge/new/')({
  component: PageComponent,
});
