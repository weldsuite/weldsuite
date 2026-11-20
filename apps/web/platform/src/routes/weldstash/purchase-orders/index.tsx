import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/purchase-orders/page';

export const Route = createFileRoute('/weldstash/purchase-orders/')({
  component: PageComponent,
});
