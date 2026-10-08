import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/deposits/page';

export const Route = createFileRoute('/weldbooks/deposits/')({
  component: PageComponent,
});
