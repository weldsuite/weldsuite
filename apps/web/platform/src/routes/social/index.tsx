import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/page';

export const Route = createFileRoute('/social/')({
  component: PageComponent,
});
