import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhost/domains/page';

export const Route = createFileRoute('/weldhost/domains/')({
  component: PageComponent,
});
