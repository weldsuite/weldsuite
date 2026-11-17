import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/impact/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/impact/')({
  staticData: { breadcrumb: { labelKey: 'impact' } },
  component: PageComponent,
});
