import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/payroll/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/payroll/')({
  staticData: { breadcrumb: { label: 'Payroll' } },
  component: PageComponent,
});
