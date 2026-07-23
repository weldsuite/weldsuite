import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/social/calendar/page';

export const Route = createFileRoute('/social/calendar/')({
  component: PageComponent,
});
