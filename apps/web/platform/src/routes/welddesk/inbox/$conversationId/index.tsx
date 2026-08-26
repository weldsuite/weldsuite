import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox/inbox-page';

export const Route = createFileRoute('/welddesk/inbox/$conversationId/')({
  component: InboxConversationPage,
});

function InboxConversationPage() {
  const { conversationId } = Route.useParams();
  return <InboxPage conversationId={conversationId} />;
}
