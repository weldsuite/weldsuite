import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/workflows/page';

export const Route = createFileRoute('/welddesk/workflows/')({
  component: PageComponent,
});
