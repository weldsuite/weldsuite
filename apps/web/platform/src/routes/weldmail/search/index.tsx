import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmail/search/page';

export const Route = createFileRoute('/weldmail/search/')({
  component: PageComponent,
});
