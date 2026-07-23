import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/whiteboard/page';

export const Route = createFileRoute('/weldflow/project/$projectId/whiteboard/')({
  component: PageComponent,
});
