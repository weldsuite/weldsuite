import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/welddesk/chat-widget/page';

export const Route = createFileRoute('/welddesk/chat-widget/')({
  component: PageComponent,
});
