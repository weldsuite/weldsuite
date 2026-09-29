import { createFileRoute } from '@tanstack/react-router';
import { InboxPage } from '@/app/welddesk/inbox/inbox-page';

export const Route = createFileRoute('/preview/welddesk/inbox/')({
  component: InboxIndexPage,
});

function InboxIndexPage() {
  return <InboxPage />;
}
