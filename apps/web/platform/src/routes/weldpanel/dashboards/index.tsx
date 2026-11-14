import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/dashboards/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/dashboards/')({
  staticData: { breadcrumb: { labelKey: 'dashboards' } },
  component: PageComponent,
});
