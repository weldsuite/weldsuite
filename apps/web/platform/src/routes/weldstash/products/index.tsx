import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/products/page';

export const Route = createFileRoute('/weldstash/products/')({
  component: PageComponent,
});
