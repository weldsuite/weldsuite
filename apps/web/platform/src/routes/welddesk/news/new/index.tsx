import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/news/new/page';

export const Route = createFileRoute('/welddesk/news/new/')({
  component: PageComponent,
});
