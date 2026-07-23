import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhost/domains/purchase/cancel/page';

export const Route = createFileRoute('/weldhost/domains/purchase/cancel/')({
  component: PageComponent,
});
