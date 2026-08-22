import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldads/page';

export const Route = createFileRoute('/weldads/')({
  staticData: { breadcrumb: { label: 'Overview' } },
  component: PageComponent,
});
