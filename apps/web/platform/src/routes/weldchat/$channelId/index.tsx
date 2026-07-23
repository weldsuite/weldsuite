import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/channel/page';

export const Route = createFileRoute('/weldchat/$channelId/')({
  component: PageComponent,
});
