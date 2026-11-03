import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/gantt/dependencies/page';

export const Route = createFileRoute('/weldflow/project/$projectId/gantt/dependencies/')({
  component: PageComponent,
});
