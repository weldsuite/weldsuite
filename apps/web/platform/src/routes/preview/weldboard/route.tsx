import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldBoardShell } from '@/app/preview/weldboard/preview-weldboard-shell';

// Unauthenticated mirror of /weldboard for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/weldboard')({
  component: () => <PreviewWeldBoardShell><Outlet /></PreviewWeldBoardShell>,
});
