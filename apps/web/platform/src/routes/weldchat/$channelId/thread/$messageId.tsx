import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/thread/page';

export const Route = createFileRoute('/weldchat/$channelId/thread/$messageId')({
  component: PageComponent,
});
