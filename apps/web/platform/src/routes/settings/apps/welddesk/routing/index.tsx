import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/routing/page';

export const Route = createFileRoute('/settings/apps/welddesk/routing/')({
  component: PageComponent,
});
