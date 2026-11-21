import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/service-catalogue/page';

export const Route = createFileRoute('/settings/apps/welddesk/service-catalogue/')({
  component: PageComponent,
});
