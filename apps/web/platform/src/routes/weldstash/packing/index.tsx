import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/packing/page';

export const Route = createFileRoute('/weldstash/packing/')({
  component: PageComponent,
});
