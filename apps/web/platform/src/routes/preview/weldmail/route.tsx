import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldMailShell } from '@/app/preview/weldmail/preview-weldmail-shell';

// Unauthenticated mirror of /weldmail for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/weldmail')({
  component: () => <PreviewWeldMailShell><Outlet /></PreviewWeldMailShell>,
});
