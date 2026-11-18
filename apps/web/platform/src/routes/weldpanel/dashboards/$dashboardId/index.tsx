import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/dashboards/detail/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/dashboards/$dashboardId/')({
  staticData: { breadcrumb: { labelKey: 'dashboards', href: '/weldpanel/dashboards' } },
  component: PageComponent,
});
