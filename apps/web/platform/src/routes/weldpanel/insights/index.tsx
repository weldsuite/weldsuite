import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/insights/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/insights/')({
  staticData: { breadcrumb: { labelKey: 'insights' } },
  component: PageComponent,
});
