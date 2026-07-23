import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldchat/page';

export const Route = createFileRoute('/weldchat/')({
  component: PageComponent,
});
