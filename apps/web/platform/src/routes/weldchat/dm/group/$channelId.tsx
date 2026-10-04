import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/dm/group-conversation-page';
import { validateMessageSearch } from '@/app/weldchat/lib/message-search';

export const Route = createFileRoute('/weldchat/dm/group/$channelId')({
  validateSearch: validateMessageSearch,
  component: PageComponent,
});
