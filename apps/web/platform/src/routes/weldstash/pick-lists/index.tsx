import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldstash/pick-lists/page';

export const Route = createFileRoute('/weldstash/pick-lists/')({
  component: PageComponent,
});
