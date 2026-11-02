import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/helpcenter/page';

export const Route = createFileRoute('/settings/apps/welddesk/help-center/')({
  component: PageComponent,
});
