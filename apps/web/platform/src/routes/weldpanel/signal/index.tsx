import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/signal/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/signal/')({
  staticData: { breadcrumb: { labelKey: 'signal' } },
  component: PageComponent,
});
