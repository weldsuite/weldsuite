import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/')({
  staticData: { breadcrumb: { label: 'Dashboard' } },
  component: PageComponent,
});
