import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/stock/page';

export const Route = createFileRoute('/weldstash/stock/')({
  component: PageComponent,
});
