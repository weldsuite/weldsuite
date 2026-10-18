import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/dashboard/builder/page';

export const Route = createFileRoute('/weldbooks/dashboard/builder/')({
  component: PageComponent,
});
