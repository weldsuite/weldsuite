import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/discounts/page';

export const Route = createFileRoute('/weldcommerce/discounts/')({
  component: PageComponent,
});
