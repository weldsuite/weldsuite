import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/page';

export const Route = createFileRoute('/welddesk/')({
  component: PageComponent,
});
