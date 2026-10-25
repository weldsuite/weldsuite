import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldDocsShell } from '@/app/preview/welddocs/preview-welddocs-shell';

// Unauthenticated mirror of /welddocs for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/welddocs')({
  component: () => <PreviewWeldDocsShell><Outlet /></PreviewWeldDocsShell>,
});
