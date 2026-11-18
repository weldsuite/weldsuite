import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/data/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/data/')({
  staticData: { breadcrumb: { labelKey: 'panelData' } },
  component: PageComponent,
});
