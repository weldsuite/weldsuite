import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/partner/workspaces/detail-page';

export const Route = createFileRoute('/partner/workspaces/$workspaceId/')({
  component: PageComponent,
});
