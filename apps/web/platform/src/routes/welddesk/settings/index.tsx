import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/settings/page';

export const Route = createFileRoute('/welddesk/settings/')({
  component: PageComponent,
});
