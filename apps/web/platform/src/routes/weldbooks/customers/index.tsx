import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldbooks/customers/page';

export const Route = createFileRoute('/weldbooks/customers/')({
  component: PageComponent,
});
