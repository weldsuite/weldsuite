import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/groups/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/groups/')({
  staticData: { breadcrumb: { labelKey: 'panelGroups' } },
  component: PageComponent,
});
