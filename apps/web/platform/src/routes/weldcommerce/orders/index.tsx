import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/orders/page';

export const Route = createFileRoute('/weldcommerce/orders/')({
  component: PageComponent,
});
