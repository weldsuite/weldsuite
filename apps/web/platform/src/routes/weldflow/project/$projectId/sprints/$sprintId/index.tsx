import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/sprints/[sprintId]/page';

export const Route = createFileRoute('/weldflow/project/$projectId/sprints/$sprintId/')({
  component: PageComponent,
});
