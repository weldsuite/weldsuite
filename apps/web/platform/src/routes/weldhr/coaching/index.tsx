import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/coaching/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/coaching/')({
  staticData: { breadcrumb: { label: 'Coaching' } },
  component: PageComponent,
});
