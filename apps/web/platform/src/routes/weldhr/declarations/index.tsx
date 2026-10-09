import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/declarations/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/declarations/')({
  staticData: { breadcrumb: { label: 'Declarations' } },
  component: PageComponent,
});
