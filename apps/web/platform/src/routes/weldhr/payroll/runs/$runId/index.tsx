import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldhr/payroll/runs/[runId]/page';
import '@/lib/breadcrumbs/types';

export const Route = createFileRoute('/weldhr/payroll/runs/$runId/')({
  component: PageComponent,
});
