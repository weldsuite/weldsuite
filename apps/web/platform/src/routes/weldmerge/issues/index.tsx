import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/issues/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldmerge/issues/')({
  staticData: { breadcrumb: { labelKey: 'issues' } },
  component: PageComponent,
});
