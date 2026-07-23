import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/layout';
import { MailPendingSkeleton } from '@/app/weldmail/components/mail-pending-skeleton';

export const Route = createFileRoute('/weldmail')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
  // Mail-shaped pending UI instead of the generic dashboard skeleton, so cold
  // entry into the module reads as the inbox (split list + detail), not a table.
  pendingComponent: MailPendingSkeleton,
});
