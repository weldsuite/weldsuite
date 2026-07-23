import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/page';

export const Route = createFileRoute('/weldstash/')({
  component: PageComponent,
});
