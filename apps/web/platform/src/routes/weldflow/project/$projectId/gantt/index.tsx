import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/gantt/page';

export const Route = createFileRoute('/weldflow/project/$projectId/gantt/')({
  component: PageComponent,
});
