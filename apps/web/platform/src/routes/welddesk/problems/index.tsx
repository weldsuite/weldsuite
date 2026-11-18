import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/problems/page';

export const Route = createFileRoute('/welddesk/problems/')({
  component: PageComponent,
});
