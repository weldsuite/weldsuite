import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldFormsShell } from '@/app/preview/weldforms/preview-weldforms-shell';
import '@/lib/breadcrumbs/types';

// Unauthenticated, backend-free mirror of /weldforms (see PreviewWeldFormsShell).
export const Route = createFileRoute('/preview/weldforms')({
  staticData: { breadcrumb: { label: 'WeldForms' } },
  component: () => (
    <PreviewWeldFormsShell>
      <Outlet />
    </PreviewWeldFormsShell>
  ),
});
