import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/performance/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/performance/')({
  staticData: { breadcrumb: { labelKey: 'performance' } },
  component: PageComponent,
});
