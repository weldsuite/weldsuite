import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox/inbox-page';

export const Route = createFileRoute('/welddesk/inbox/email/')({
  component: EmailInboxIndexPage,
});

function EmailInboxIndexPage() {
  return <InboxPage channel="email" />;
}
