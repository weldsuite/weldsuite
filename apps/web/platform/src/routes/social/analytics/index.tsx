import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/analytics/page';

export const Route = createFileRoute('/social/analytics/')({
  component: PageComponent,
});
