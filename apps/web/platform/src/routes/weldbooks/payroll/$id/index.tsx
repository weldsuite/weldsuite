import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/payroll/[id]/page';

export const Route = createFileRoute('/weldbooks/payroll/$id/')({
  component: PageComponent,
});
