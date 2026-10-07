import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldknow/teamspaces/page';

export const Route = createFileRoute('/weldknow/teamspaces/')({
  component: PageComponent,
});
