import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/reports/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/reports/')({
  staticData: { breadcrumb: { labelKey: 'reports' } },
  component: PageComponent,
});
