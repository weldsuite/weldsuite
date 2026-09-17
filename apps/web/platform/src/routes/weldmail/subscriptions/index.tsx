import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/subscriptions/page';

export const Route = createFileRoute('/weldmail/subscriptions/')({
  component: PageComponent,
});
