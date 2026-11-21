import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/lifecycle/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/lifecycle/')({
  staticData: { breadcrumb: { labelKey: 'lifecycle' } },
  component: PageComponent,
});
