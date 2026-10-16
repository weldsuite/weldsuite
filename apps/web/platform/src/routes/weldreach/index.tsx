import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldreach/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldreach/')({
  staticData: { breadcrumb: { labelKey: 'overview' } },
  component: PageComponent,
});
