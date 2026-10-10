import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/tasks/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/tasks/')({
  staticData: { breadcrumb: { label: 'Tasks' } },
  component: PageComponent,
});
