import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhost/domains/[id]/page';

export const Route = createFileRoute('/weldhost/domains/$id/')({
  component: PageComponent,
});
