import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PreviewWeldCalendarShell } from '@/app/preview/weldcalendar/preview-weldcalendar-shell';

// Unauthenticated mirror of /weldcalendar for support videos (see PreviewModeProvider).
export const Route = createFileRoute('/preview/weldcalendar')({
  component: () => <PreviewWeldCalendarShell><Outlet /></PreviewWeldCalendarShell>,
});
