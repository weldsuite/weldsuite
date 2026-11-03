import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox/inbox-page';

export const Route = createFileRoute('/welddesk/inbox/chat/$conversationId/')({
  component: ChatInboxConversationPage,
});

function ChatInboxConversationPage() {
  const { conversationId } = Route.useParams();
  return <InboxPage conversationId={conversationId} channel="messenger" />;
}
