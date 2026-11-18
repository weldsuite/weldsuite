import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/frustration/page';

export const Route = createFileRoute('/weldpanel/frustration/')({
  component: PageComponent,
});
