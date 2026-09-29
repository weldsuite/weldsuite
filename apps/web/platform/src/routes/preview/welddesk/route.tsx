import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldDeskShell } from '@/app/preview/welddesk/preview-welddesk-shell';

// Unauthenticated mirror of /welddesk for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/welddesk')({
  component: () => <PreviewWeldDeskShell><Outlet /></PreviewWeldDeskShell>,
});
