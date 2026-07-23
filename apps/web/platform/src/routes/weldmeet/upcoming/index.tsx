import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmeet/upcoming/page';

export const Route = createFileRoute('/weldmeet/upcoming/')({
  component: PageComponent,
});
