import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/live/page';

export const Route = createFileRoute('/weldpanel/live/')({
  component: PageComponent,
});
