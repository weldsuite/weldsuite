import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/statements/[id]/report/page';

export const Route = createFileRoute('/weldbooks/banking/statements/$id/report/')({
  component: PageComponent,
});
