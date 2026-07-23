import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/inbox/page';

export const Route = createFileRoute('/weldmail/inbox/')({
  component: PageComponent,
});
