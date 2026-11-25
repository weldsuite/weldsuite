import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/tasks/backlog/page';

export const Route = createFileRoute('/weldflow/project/$projectId/tasks/backlog/')({
  component: PageComponent,
});
