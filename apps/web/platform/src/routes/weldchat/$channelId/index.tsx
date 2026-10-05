import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/channel/page';
import { validateMessageSearch } from '@/app/weldchat/lib/message-search';

export const Route = createFileRoute('/weldchat/$channelId/')({
  validateSearch: validateMessageSearch,
  component: PageComponent,
});
