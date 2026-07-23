import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/customers/[id]/page';

export const Route = createFileRoute('/weldbooks/customers/$id/')({
  component: PageComponent,
});
