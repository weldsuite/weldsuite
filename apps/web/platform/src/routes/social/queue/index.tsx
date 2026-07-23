import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/queue/page';

export const Route = createFileRoute('/social/queue/')({
  component: PageComponent,
});
