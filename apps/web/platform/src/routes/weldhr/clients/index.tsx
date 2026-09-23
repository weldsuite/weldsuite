import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/clients/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/clients/')({
  staticData: { breadcrumb: { label: 'Client accounts' } },
  component: PageComponent,
});
