import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldCrmShell } from '@/app/preview/weldcrm/preview-weldcrm-shell';
import '@/lib/breadcrumbs/types';

// Unauthenticated mirror of /weldcrm for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/weldcrm')({
  staticData: { breadcrumb: { label: 'CRM' } },
  component: () => <PreviewWeldCrmShell><Outlet /></PreviewWeldCrmShell>,
});
