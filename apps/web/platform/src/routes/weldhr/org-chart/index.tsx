import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/org-chart/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/org-chart/')({
  staticData: { breadcrumb: { label: 'Org chart' } },
  component: PageComponent,
});
