import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/payroll/runs/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/payroll/runs/')({
  staticData: { breadcrumb: { label: 'Pay runs' } },
  component: PageComponent,
});
