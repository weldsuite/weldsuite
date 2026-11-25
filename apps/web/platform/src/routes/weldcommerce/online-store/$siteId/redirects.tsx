import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/online-store/redirects/page';

export const Route = createFileRoute('/weldcommerce/online-store/$siteId/redirects')({
  component: PageComponent,
});
