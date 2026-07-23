import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/settings/apps/welddesk/page';

export const Route = createFileRoute('/settings/apps/welddesk/')({
  component: PageComponent,
});
