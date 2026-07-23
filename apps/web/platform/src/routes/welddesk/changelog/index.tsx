import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/changelog/page';

export const Route = createFileRoute('/welddesk/changelog/')({
  component: PageComponent,
});
