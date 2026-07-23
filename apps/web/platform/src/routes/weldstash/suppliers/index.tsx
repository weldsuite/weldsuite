import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/suppliers/page';

export const Route = createFileRoute('/weldstash/suppliers/')({
  component: PageComponent,
});
