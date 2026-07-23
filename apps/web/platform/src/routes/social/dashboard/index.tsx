import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/dashboard/page';

export const Route = createFileRoute('/social/dashboard/')({
  component: PageComponent,
});
