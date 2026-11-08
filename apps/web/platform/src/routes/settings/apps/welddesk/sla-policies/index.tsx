import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/sla-policies/page';

export const Route = createFileRoute('/settings/apps/welddesk/sla-policies/')({
  component: PageComponent,
});
