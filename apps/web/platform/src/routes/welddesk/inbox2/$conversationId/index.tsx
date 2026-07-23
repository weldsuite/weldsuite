// TODO(cleanup): replace legacy inbox route — see .claude/welddesk-intercom-plan.md
// §6 Phase 2.
import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox2/inbox-page';

export const Route = createFileRoute('/welddesk/inbox2/$conversationId/')({
  validateSearch: (search: Record<string, unknown>) => ({
    section: (search.section as string) || undefined,
    teamId: (search.teamId as string) || undefined,
    viewId: (search.viewId as string) || undefined,
  }),
  component: InboxConversationPage,
});

function InboxConversationPage() {
  const { conversationId } = Route.useParams();
  return <InboxPage conversationId={conversationId} />;
}
