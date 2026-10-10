import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/payroll/settings/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/payroll/settings/')({
  staticData: { breadcrumb: { label: 'Payroll settings' } },
  component: PageComponent,
});
