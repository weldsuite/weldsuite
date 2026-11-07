import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/pull-requests/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldmerge/pull-requests/')({
  staticData: { breadcrumb: { labelKey: 'pullRequests' } },
  component: PageComponent,
});
