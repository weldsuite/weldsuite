import { createFileRoute } from '@tanstack/react-router';
import PageComponent from '@/app/weldflow/project/[projectId]/whiteboard/[whiteboardId]/page';

export const Route = createFileRoute('/weldflow/project/$projectId/whiteboard/$whiteboardId/')({
  component: PageComponent,
});
