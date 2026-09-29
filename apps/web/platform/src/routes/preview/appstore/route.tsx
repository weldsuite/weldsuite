import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewAppStoreShell } from '@/app/preview/appstore/preview-appstore-shell';

// Unauthenticated mirror of /appstore for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/appstore')({
  component: () => <PreviewAppStoreShell><Outlet /></PreviewAppStoreShell>,
});
