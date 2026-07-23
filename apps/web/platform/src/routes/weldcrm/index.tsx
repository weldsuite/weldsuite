import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm/')({
  staticData: { breadcrumb: { label: 'My Tasks' } },
  component: PageComponent,
});
