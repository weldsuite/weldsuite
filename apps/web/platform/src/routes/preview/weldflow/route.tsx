import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldFlowShell } from '@/app/preview/weldflow/preview-weldflow-shell';

// Unauthenticated mirror of /weldflow for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/weldflow')({
  component: () => <PreviewWeldFlowShell><Outlet /></PreviewWeldFlowShell>,
});
