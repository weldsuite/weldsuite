import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhost/domains/purchase/success/page';

export const Route = createFileRoute('/weldhost/domains/purchase/success/')({
  component: PageComponent,
});
