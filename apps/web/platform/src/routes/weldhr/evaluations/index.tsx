import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/evaluations/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/evaluations/')({
  staticData: { breadcrumb: { label: 'Evaluations' } },
  component: PageComponent,
});
