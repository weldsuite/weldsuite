import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/tasks/page';

export const Route = createFileRoute('/preview/weldflow/project/$projectId/tasks/')({
  component: PageComponent,
});
