import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/chat-widget/page';

export const Route = createFileRoute('/settings/apps/welddesk/chat-widget/')({
  component: PageComponent,
});
