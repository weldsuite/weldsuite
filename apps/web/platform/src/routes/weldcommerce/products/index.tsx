import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/products/page';

export const Route = createFileRoute('/weldcommerce/products/')({
  component: PageComponent,
});
