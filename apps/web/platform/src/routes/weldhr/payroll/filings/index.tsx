import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/payroll/filings/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/payroll/filings/')({
  staticData: { breadcrumb: { label: 'Filings' } },
  component: PageComponent,
});
