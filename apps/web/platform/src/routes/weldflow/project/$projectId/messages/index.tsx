import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/messages/page';

export const Route = createFileRoute('/weldflow/project/$projectId/messages/')({
  component: PageComponent,
});
