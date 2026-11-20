import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/funnels/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/funnels/')({
  staticData: { breadcrumb: { labelKey: 'funnels' } },
  component: PageComponent,
});
