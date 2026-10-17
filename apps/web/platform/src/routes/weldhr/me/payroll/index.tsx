import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/me/payroll/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/me/payroll/')({
  staticData: { breadcrumb: { labelKey: 'payroll' } },
  component: PageComponent,
});
