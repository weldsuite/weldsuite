import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/metric-trees/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/metric-trees/')({
  staticData: { breadcrumb: { labelKey: 'metricTrees' } },
  component: PageComponent,
});
