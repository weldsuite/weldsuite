import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/workspaces/page';

export const Route = createFileRoute('/partner/workspaces/')({
  component: PageComponent,
});
