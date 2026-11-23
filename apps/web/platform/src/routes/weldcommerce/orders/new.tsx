import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/orders/new/page';

export const Route = createFileRoute('/weldcommerce/orders/new')({
  component: PageComponent,
});
