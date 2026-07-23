import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmeet/people/page';

export const Route = createFileRoute('/weldmeet/people/')({
  component: PageComponent,
});
