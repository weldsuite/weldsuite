import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldDocsShell } from '@/app/preview/welddocs/preview-welddocs-shell';
import { WeldDocsPendingSkeleton } from '@/app/welddocs/doc/doc-skeleton';

// Unauthenticated mirror of /welddocs for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/welddocs')({
  component: () => <PreviewWeldDocsShell><Outlet /></PreviewWeldDocsShell>,
  // As in /welddocs: a document's URL shows a document-shaped skeleton, not the dashboard one.
  pendingComponent: WeldDocsPendingSkeleton,
});
