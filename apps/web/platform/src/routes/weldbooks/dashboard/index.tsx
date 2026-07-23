import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/dashboard/page';

export const Route = createFileRoute('/weldbooks/dashboard/')({
  component: PageComponent,
});
