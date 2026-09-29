import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldHostShell } from '@/app/preview/weldhost/preview-weldhost-shell';

// Unauthenticated mirror of /weldhost for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/weldhost')({
  component: () => <PreviewWeldHostShell><Outlet /></PreviewWeldHostShell>,
});
