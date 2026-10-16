import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/sequences/[id]/people/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm/sequences/$id/people/')({
  staticData: { breadcrumb: { labelKey: 'people' } },
  component: PageComponent,
});
