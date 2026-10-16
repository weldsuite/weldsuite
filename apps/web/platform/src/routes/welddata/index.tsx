import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddata/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/welddata/')({
  staticData: { breadcrumb: { labelKey: 'findLeads' } },
  component: PageComponent,
});
