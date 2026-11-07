import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldmerge/cycles/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldmerge/cycles/')({
  staticData: { breadcrumb: { labelKey: 'cycles' } },
  component: PageComponent,
});
