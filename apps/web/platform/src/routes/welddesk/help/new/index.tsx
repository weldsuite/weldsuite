import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/help/new/page';

export const Route = createFileRoute('/welddesk/help/new/')({
  component: PageComponent,
});
