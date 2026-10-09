import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payroll/page';

export const Route = createFileRoute('/weldbooks/payroll/')({
  component: PageComponent,
});
