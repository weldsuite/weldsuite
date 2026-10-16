import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcrm/sequences/[id]/settings/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldcrm/sequences/$id/settings/')({
  staticData: { breadcrumb: { labelKey: 'settings' } },
  component: PageComponent,
});
