import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/online-store/menus/page';

export const Route = createFileRoute('/weldcommerce/online-store/$siteId/menus')({
  component: PageComponent,
});
