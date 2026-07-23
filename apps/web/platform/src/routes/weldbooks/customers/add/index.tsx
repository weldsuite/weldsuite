import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/customers/add/page';

export const Route = createFileRoute('/weldbooks/customers/add/')({
  component: PageComponent,
});
