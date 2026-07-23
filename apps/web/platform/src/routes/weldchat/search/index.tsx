import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/search/page';

export const Route = createFileRoute('/weldchat/search/')({
  component: PageComponent,
});
