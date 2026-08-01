import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/customers/page';

export const Route = createFileRoute('/weldcommerce/customers/')({
  component: PageComponent,
});
