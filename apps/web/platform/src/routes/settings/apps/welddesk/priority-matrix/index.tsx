import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/priority-matrix/page';

export const Route = createFileRoute('/settings/apps/welddesk/priority-matrix/')({
  component: PageComponent,
});
