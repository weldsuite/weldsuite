import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/banking/statements/[id]/page';

export const Route = createFileRoute('/weldbooks/banking/statements/$id/')({
  component: PageComponent,
});
