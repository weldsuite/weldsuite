import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/warehouses/page';

export const Route = createFileRoute('/weldstash/warehouses/')({
  component: PageComponent,
});
