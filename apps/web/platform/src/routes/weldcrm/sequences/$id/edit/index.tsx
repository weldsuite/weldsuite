import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/sequences/[id]/edit/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm/sequences/$id/edit/')({
  staticData: { breadcrumb: { label: 'Edit' } },
  component: PageComponent,
});
