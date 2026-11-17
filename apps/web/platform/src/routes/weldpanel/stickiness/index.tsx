import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/stickiness/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/stickiness/')({
  staticData: { breadcrumb: { labelKey: 'stickiness' } },
  component: PageComponent,
});
