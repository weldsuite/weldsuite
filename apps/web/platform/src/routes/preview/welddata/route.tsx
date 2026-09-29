import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWelddataShell } from '@/app/preview/welddata/preview-welddata-shell';

// Unauthenticated mirror of /welddata for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/welddata')({
  component: () => <PreviewWelddataShell><Outlet /></PreviewWelddataShell>,
});
