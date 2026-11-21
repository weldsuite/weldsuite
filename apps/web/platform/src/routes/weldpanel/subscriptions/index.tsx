import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/subscriptions/page';

export const Route = createFileRoute('/weldpanel/subscriptions/')({
  component: PageComponent,
});
