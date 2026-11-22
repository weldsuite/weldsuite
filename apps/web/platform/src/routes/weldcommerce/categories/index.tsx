import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/categories/page';

export const Route = createFileRoute('/weldcommerce/categories/')({
  component: PageComponent,
});
