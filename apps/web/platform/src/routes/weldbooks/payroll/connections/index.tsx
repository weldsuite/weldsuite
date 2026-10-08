import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payroll/connections/page';

export const Route = createFileRoute('/weldbooks/payroll/connections/')({
  component: PageComponent,
});
