import { createFileRoute, Outlet } from '@tanstack/react-router';
import '@/lib/breadcrumbs/types';
import LayoutComponent from '@/app/welddocs/layout';
import { WeldDocsPendingSkeleton } from '@/app/welddocs/doc/doc-skeleton';

export const Route = createFileRoute('/welddocs')({
  staticData: { breadcrumb: { label: 'WeldDocs' } },
  component: () => (
    <LayoutComponent>
      <Outlet />
    </LayoutComponent>
  ),
  // Loads first on a page load: a document's URL shows a document-shaped skeleton, not the dashboard one.
  pendingComponent: WeldDocsPendingSkeleton,
});
