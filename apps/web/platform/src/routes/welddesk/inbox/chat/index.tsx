import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox/inbox-page';

export const Route = createFileRoute('/welddesk/inbox/chat/')({
  component: ChatInboxIndexPage,
});

function ChatInboxIndexPage() {
  return <InboxPage channel="messenger" />;
}
