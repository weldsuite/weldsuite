import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/payroll/employees/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/payroll/employees/')({
  staticData: { breadcrumb: { label: 'Payroll employees' } },
  component: PageComponent,
});
