import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/reviews/page';

export const Route = createFileRoute('/welddesk/reviews/')({
  component: PageComponent,
});
