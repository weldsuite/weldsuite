import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/users/page';

export const Route = createFileRoute('/weldpanel/users/')({
  component: PageComponent,
});
