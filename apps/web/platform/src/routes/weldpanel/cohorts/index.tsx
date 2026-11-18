import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/cohorts/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/cohorts/')({
  staticData: { breadcrumb: { labelKey: 'cohorts' } },
  component: PageComponent,
});
