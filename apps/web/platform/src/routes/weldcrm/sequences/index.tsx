import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/sequences/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm/sequences/')({
  staticData: { breadcrumb: { labelKey: 'sequences' } },
  component: PageComponent,
});
