import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewSettingsShell } from '@/app/preview/settings/preview-settings-shell';

// Unauthenticated mirror of /settings for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/settings')({
  component: () => <PreviewSettingsShell><Outlet /></PreviewSettingsShell>,
});
