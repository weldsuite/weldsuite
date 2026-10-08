import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payroll/import/page';

export const Route = createFileRoute('/weldbooks/payroll/import/')({
  component: PageComponent,
});
