import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/online-store/pages/page';

export const Route = createFileRoute('/weldcommerce/online-store/$siteId/pages')({
  component: PageComponent,
});
