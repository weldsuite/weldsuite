import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/users/detail/page';

export const Route = createFileRoute('/weldpanel/users/$distinctId/')({
  component: PageComponent,
});
