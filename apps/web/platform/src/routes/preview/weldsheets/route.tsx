import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldSheetsShell } from '@/app/preview/weldsheets/preview-weldsheets-shell';

// Unauthenticated mirror of /weldsheets for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/weldsheets')({
  component: () => <PreviewWeldSheetsShell><Outlet /></PreviewWeldSheetsShell>,
});
