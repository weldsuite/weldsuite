import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/help/page';

export const Route = createFileRoute('/welddesk/help/')({
  component: PageComponent,
});
