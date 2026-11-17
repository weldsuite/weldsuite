import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/metric-trees/detail/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/metric-trees/$treeId/')({
  staticData: { breadcrumb: { labelKey: 'metricTrees', href: '/weldpanel/metric-trees' } },
  component: PageComponent,
});
