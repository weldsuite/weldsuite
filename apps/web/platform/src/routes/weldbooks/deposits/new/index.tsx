import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/deposits/new/page';

export const Route = createFileRoute('/weldbooks/deposits/new/')({
  component: PageComponent,
});
