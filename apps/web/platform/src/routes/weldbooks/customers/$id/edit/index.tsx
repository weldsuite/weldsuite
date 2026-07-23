import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/customers/[id]/edit/page';

export const Route = createFileRoute('/weldbooks/customers/$id/edit/')({
  component: PageComponent,
});
