import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/bookmarks/page';

export const Route = createFileRoute('/weldchat/bookmarks/')({
  component: PageComponent,
});
