import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox/inbox-page';

export const Route = createFileRoute('/welddesk/inbox/')({
  component: InboxIndexPage,
});

function InboxIndexPage() {
  return <InboxPage />;
}
