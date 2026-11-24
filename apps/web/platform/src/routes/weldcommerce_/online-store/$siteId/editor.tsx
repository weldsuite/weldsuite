import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldcommerce/online-store/editor/page';

// `weldcommerce_` keeps the editor out of the WeldCommerce layout: it is a
// full-screen tool (the app shell leaves out its sidebar too, see
// components/app-shell-client.tsx).
export const Route = createFileRoute('/weldcommerce_/online-store/$siteId/editor')({
  component: PageComponent,
});
