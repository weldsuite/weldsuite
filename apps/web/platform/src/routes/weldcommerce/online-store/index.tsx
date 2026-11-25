import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/online-store/page';

export const Route = createFileRoute('/weldcommerce/online-store/')({
  component: PageComponent,
});
