import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/team/page';

export const Route = createFileRoute('/social/team/')({
  component: PageComponent,
});
