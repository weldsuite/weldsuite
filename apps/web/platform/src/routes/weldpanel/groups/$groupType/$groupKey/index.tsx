import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/groups/detail/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/groups/$groupType/$groupKey/')({
  staticData: { breadcrumb: { labelKey: 'panelGroups', href: '/weldpanel/groups' } },
  component: PageComponent,
});
