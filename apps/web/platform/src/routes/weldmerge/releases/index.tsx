import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/releases/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldmerge/releases/')({
  staticData: { breadcrumb: { labelKey: 'releases' } },
  component: PageComponent,
});
