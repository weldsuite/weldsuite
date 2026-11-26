import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/sprints/[sprintId]/retro/page';

export const Route = createFileRoute('/weldflow/project/$projectId/sprints/$sprintId/retro/')({
  component: PageComponent,
});
