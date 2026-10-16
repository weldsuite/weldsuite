import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldreach/campaigns/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldreach/campaigns/')({
  staticData: { breadcrumb: { labelKey: 'campaigns' } },
  component: PageComponent,
});
