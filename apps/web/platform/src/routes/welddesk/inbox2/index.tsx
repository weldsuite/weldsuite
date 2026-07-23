// TODO(cleanup): replace legacy inbox route — see .claude/welddesk-intercom-plan.md
// §6 Phase 2. /welddesk/inbox2 is the new Intercom-model inbox; the legacy
// /welddesk/inbox/* routes stay untouched until parity + cleanup.
import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox2/inbox-page';

export const Route = createFileRoute('/welddesk/inbox2/')({
  validateSearch: (search: Record<string, unknown>) => ({
    section: (search.section as string) || undefined,
    teamId: (search.teamId as string) || undefined,
    viewId: (search.viewId as string) || undefined,
  }),
  component: InboxIndexPage,
});

function InboxIndexPage() {
  return <InboxPage />;
}
