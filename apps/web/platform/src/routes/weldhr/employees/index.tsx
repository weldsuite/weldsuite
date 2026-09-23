import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/employees/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/employees/')({
  staticData: { breadcrumb: { label: 'Employees' } },
  component: PageComponent,
});
