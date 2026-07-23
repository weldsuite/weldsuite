import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/inbox/compose/page';

export const Route = createFileRoute('/weldmail/inbox/compose/')({
  component: PageComponent,
});
