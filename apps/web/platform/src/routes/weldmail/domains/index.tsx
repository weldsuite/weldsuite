import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/domains/page';

export const Route = createFileRoute('/weldmail/domains/')({
  component: PageComponent,
});
