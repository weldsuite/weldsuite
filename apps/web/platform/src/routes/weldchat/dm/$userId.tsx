import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/dm/conversation-page';

export const Route = createFileRoute('/weldchat/dm/$userId')({
  component: PageComponent,
});
