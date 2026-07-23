import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/news/page';

export const Route = createFileRoute('/welddesk/news/')({
  component: PageComponent,
});
