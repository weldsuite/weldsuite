import { createFileRoute, Outlet } from '@tanstack/react-router';
import LayoutComponent from '@/app/weldmail/layout';
import { MailPendingSkeleton } from '@/app/weldmail/components/mail-pending-skeleton';
import { abandonMailOpen, startMailOpen } from '@/app/weldmail/lib/open-timing';

export const Route = createFileRoute('/weldmail')({
  component: () => <LayoutComponent><Outlet /></LayoutComponent>,
  // Mail-shaped pending UI instead of the generic dashboard skeleton, so cold
  // entry into the module reads as the inbox (split list + detail), not a table.
  pendingComponent: MailPendingSkeleton,
  // Time opening mail (app/weldmail/lib/open-timing.ts). The root match is
  // only `enter` on the first route the app resolves, i.e. a page load.
  beforeLoad: ({ cause, matches }) => {
    if (cause === 'enter') startMailOpen(matches[0]?.cause === 'enter');
  },
  onLeave: () => abandonMailOpen(),
});
