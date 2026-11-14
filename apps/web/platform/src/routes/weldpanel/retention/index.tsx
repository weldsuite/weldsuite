import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldpanel/retention/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldpanel/retention/')({
  staticData: { breadcrumb: { labelKey: 'retention' } },
  component: PageComponent,
});
