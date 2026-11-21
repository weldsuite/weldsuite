import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/purchase-orders/[orderId]/page';

export const Route = createFileRoute('/weldstash/purchase-orders/$orderId/')({
  component: PageComponent,
});
