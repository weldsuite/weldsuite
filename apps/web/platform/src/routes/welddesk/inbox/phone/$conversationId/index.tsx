import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox/inbox-page';

export const Route = createFileRoute('/welddesk/inbox/phone/$conversationId/')({
  component: PhoneInboxConversationPage,
});

function PhoneInboxConversationPage() {
  const { conversationId } = Route.useParams();
  return <InboxPage conversationId={conversationId} channel="phone" />;
}
