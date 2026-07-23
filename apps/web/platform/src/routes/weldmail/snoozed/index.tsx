import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/snoozed/page';

export const Route = createFileRoute('/weldmail/snoozed/')({
  component: PageComponent,
});
