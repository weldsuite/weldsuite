import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmeet/history/page';

export const Route = createFileRoute('/weldmeet/history/')({
  component: PageComponent,
});
