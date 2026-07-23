import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhost/domains/search/page';

export const Route = createFileRoute('/weldhost/domains/search/')({
  component: PageComponent,
});
