import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/dm/conversation-page';
import { validateMessageSearch } from '@/app/weldchat/lib/message-search';

export const Route = createFileRoute('/weldchat/dm/$userId')({
  validateSearch: validateMessageSearch,
  component: PageComponent,
});
