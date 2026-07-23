import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhost/domains/external/page';

export const Route = createFileRoute('/weldhost/domains/external/')({
  component: PageComponent,
});
