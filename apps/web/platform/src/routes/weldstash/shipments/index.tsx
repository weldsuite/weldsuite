import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/shipments/page';

export const Route = createFileRoute('/weldstash/shipments/')({
  component: PageComponent,
});
