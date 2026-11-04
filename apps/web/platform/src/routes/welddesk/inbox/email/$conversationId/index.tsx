import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox/inbox-page';

export const Route = createFileRoute('/welddesk/inbox/email/$conversationId/')({
  component: EmailInboxConversationPage,
});

function EmailInboxConversationPage() {
  const { conversationId } = Route.useParams();
  return <InboxPage conversationId={conversationId} channel="email" />;
}
