import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/dm/group-conversation-page';

export const Route = createFileRoute('/weldchat/dm/group/$channelId')({
  component: PageComponent,
});
