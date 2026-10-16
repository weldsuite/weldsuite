import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldreach/prospects/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldreach/prospects/')({
  staticData: { breadcrumb: { labelKey: 'prospects' } },
  component: PageComponent,
});
