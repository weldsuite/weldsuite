import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/scheduled/page';

export const Route = createFileRoute('/weldmail/scheduled/')({
  component: PageComponent,
});
