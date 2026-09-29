import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldChatShell } from '@/app/preview/weldchat/preview-weldchat-shell';

// Unauthenticated mirror of /weldchat for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/weldchat')({
  component: () => <PreviewWeldChatShell><Outlet /></PreviewWeldChatShell>,
});
